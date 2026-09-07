package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sealedRequest(t *testing.T) requestEnvelope {
	t.Helper()
	previousWorkspace := authorizationWorkspaceHost
	authorizationWorkspaceHost = t.TempDir()
	t.Cleanup(func() { authorizationWorkspaceHost = previousWorkspace })
	if err := os.MkdirAll(filepath.Join(authorizationWorkspaceHost, "hermes-build-steward", "src"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(authorizationWorkspaceHost, "hermes-build-steward", "tests"), 0700); err != nil {
		t.Fatal(err)
	}
	previousRuntime := runtimeExecutablePath
	runtimeExecutablePath = filepath.Join(t.TempDir(), "exec01-runtime")
	if err := os.WriteFile(runtimeExecutablePath, []byte("sixth-rework-runtime"), 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { runtimeExecutablePath = previousRuntime })
	runtimeDigest, err := fileDigest(runtimeExecutablePath)
	if err != nil {
		t.Fatal(err)
	}
	content := map[string]interface{}{"pmInstruction": "approved", "scope": []interface{}{"hermes-build-steward/**"}}
	rawContent, _ := json.Marshal(content)
	digest := sha256.Sum256(rawContent)
	request := requestEnvelope{
		TaskID: "Q02", TaskFingerprint: string(make([]byte, 64)), AttemptID: "attempt-q2",
		ExecutorProfile:  executorProfileIdentity{ProfileID: "codex-source-runtime", ProfileFingerprint: string(make([]byte, 64)), Provider: "codex"},
		ExecutionContent: content, ExecutionContentFingerprint: hex.EncodeToString(digest[:]),
		ObservedExecutorIdentity:  observedIdentity{RuntimeWrapperDigest: runtimeDigest},
		ApprovedCommands:          []string{"sh q16-build.sh"},
		PermittedRepositoryAreas:  []string{"hermes-build-steward/**", ".github/workflows/hermes-build-steward.yml"},
		ProhibitedRepositoryAreas: []string{"hermes-build-steward/secrets/**", "client/**", "server/**"},
	}
	raw, _ := json.Marshal(request)
	t.Setenv("EXEC_REQUEST_B64", base64.StdEncoding.EncodeToString(raw))
	observed, prompt, err := loadRequest()
	if err != nil {
		t.Fatal(err)
	}
	if observed.TaskID != request.TaskID || string(prompt) != string(rawContent) {
		t.Fatal("sealed execution content was not preserved")
	}
	return request
}

func TestQ2SealedRequestContentIsVerified(t *testing.T) { sealedRequest(t) }

func TestQ4CodexJSONLTerminalAndCommandAreParsed(t *testing.T) {
	request := sealedRequest(t)
	raw := []byte("{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"command\":\"sh q16-build.sh\",\"exit_code\":0,\"status\":\"completed\"}}\n{\"type\":\"turn.completed\"}\n")
	result, err := parseCodex(raw, request, "2026-09-07T00:00:00Z", "2026-09-07T00:00:01Z", 0)
	if err != nil || result.Status != "completed" || len(result.Commands) != 1 || len(result.Tests) != 1 {
		t.Fatalf("Codex protocol was not normalized: %#v %v", result, err)
	}
}

func TestQ5ClaudeStreamJSONTerminalAndCommandAreParsed(t *testing.T) {
	request := sealedRequest(t)
	raw := []byte("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"Bash\",\"input\":{\"command\":\"sh q16-build.sh\"}}]}}\n{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool-1\",\"is_error\":false}]}}\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"x\"}\n")
	result, err := parseClaude(raw, request, "2026-09-07T00:00:00Z", "2026-09-07T00:00:01Z", 0)
	if err != nil || result.StopReason != "end_turn" || len(result.CommandsC) != 1 || len(result.TestsC) != 1 {
		t.Fatalf("Claude protocol was not normalized: %#v %v", result, err)
	}
}

func TestQ5ClaudeNonCommandToolIdentitiesRemainConsistentWithoutFabricatedCommandEvidence(t *testing.T) {
	request := sealedRequest(t)
	raw := []byte("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"read-1\",\"name\":\"Read\",\"input\":{\"file_path\":\"README.md\"}}]}}\n{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"read-1\",\"is_error\":false}]}}\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}\n")
	result, err := parseClaude(raw, request, "2026-09-07T00:00:00Z", "2026-09-07T00:00:01Z", 0)
	if err != nil || result.StopReason != "end_turn" || len(result.CommandsC) != 0 || len(result.TestsC) != 0 {
		t.Fatalf("Claude non-command tool protocol was not faithfully normalized: %#v %v", result, err)
	}
}

func TestQ6RawResponsesAndMessagesObjectsAreNotTerminalBuilds(t *testing.T) {
	request := sealedRequest(t)
	for name, raw := range map[string][]byte{
		"responses": []byte("{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[]}\n"),
		"messages":  []byte("{\"id\":\"msg_1\",\"type\":\"message\",\"stop_reason\":\"end_turn\"}\n"),
	} {
		t.Run(name, func(t *testing.T) {
			var err error
			if name == "responses" {
				_, err = parseCodex(raw, request, "s", "e", 0)
			} else {
				_, err = parseClaude(raw, request, "s", "e", 0)
			}
			if err == nil {
				t.Fatal("raw provider API object masqueraded as a coding execution")
			}
		})
	}
}

func TestQ27CodexTerminalStateMachineRejectsContradictionsAndMissingTerminal(t *testing.T) {
	request := sealedRequest(t)
	cases := map[string]string{
		"multiple terminal":     "{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n{\"type\":\"turn.completed\"}\n{\"type\":\"turn.completed\"}\n",
		"failed then completed": "{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n{\"type\":\"turn.failed\",\"error\":{\"classification\":\"provider_unavailable\"}}\n{\"type\":\"turn.completed\"}\n",
		"event after terminal":  "{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n{\"type\":\"turn.completed\"}\n{\"type\":\"item.completed\",\"item\":{}}\n",
		"missing terminal":      "{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseCodex([]byte(raw), request, "s", "e", 0); err == nil {
				t.Fatal("contradictory or missing Codex terminal state was accepted")
			}
		})
	}
	if _, err := parseCodex([]byte("{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n{\"type\":\"turn.failed\",\"error\":{\"classification\":\"unknown\"}}\n"), request, "s", "e", 0); err == nil {
		t.Fatal("failed Codex terminal event with a zero process exit was accepted")
	}
}

func TestQ27ClaudeTerminalStateMachineRejectsContradictionsUnknownSubtypeAndToolMismatch(t *testing.T) {
	request := sealedRequest(t)
	cases := map[string]string{
		"multiple terminal":    "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}\n",
		"event after terminal": "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}\n{\"type\":\"assistant\",\"message\":{\"content\":[]}}\n",
		"unknown subtype":      "{\"type\":\"result\",\"subtype\":\"mystery\",\"is_error\":false}\n",
		"missing terminal":     "{\"type\":\"assistant\",\"message\":{\"content\":[]}}\n",
		"orphan tool result":   "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"missing\",\"is_error\":false}]}}\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}\n",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseClaude([]byte(raw), request, "s", "e", 0); err == nil {
				t.Fatal("contradictory or malformed Claude terminal state was accepted")
			}
		})
	}
}

func TestQ27UnknownFailureIsInternalAndNeverProviderUnavailable(t *testing.T) {
	if got := failureType(map[string]interface{}{"classification": "novel-provider-condition"}); got != "internal_error" {
		t.Fatalf("unknown failure classified as %q, want internal_error", got)
	}
	if got := failureType(map[string]interface{}{"classification": "provider_unavailable"}); got != "provider_unavailable" {
		t.Fatalf("explicit provider unavailability classified as %q", got)
	}
}

func TestQ40UnauthorizedCodexCommandFailsClosed(t *testing.T) {
	request := sealedRequest(t)
	raw := []byte("{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"command\":\"curl attacker.example\",\"exit_code\":0,\"status\":\"completed\"}}\n{\"type\":\"turn.completed\"}\n")
	if observation, err := parseCodex(raw, request, "s", "e", 0); err == nil || !strings.Contains(err.Error(), "not authorized") {
		t.Fatalf("unauthorized Codex command did not fail closed: %v", err)
	} else if protocolErrorType(err) != "policy_denied" {
		t.Fatalf("unauthorized Codex command classification was %q", protocolErrorType(err))
	} else if len(observation.Commands) != 1 || observation.Commands[0] != "curl attacker.example" {
		t.Fatalf("post-hoc defensive parsing concealed the observed command: %#v", observation.Commands)
	}
}

func TestQ41UnauthorizedClaudeBashFailsClosed(t *testing.T) {
	request := sealedRequest(t)
	raw := []byte("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"Bash\",\"input\":{\"command\":\"curl attacker.example\"}}]}}\n{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool-1\",\"is_error\":false}]}}\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}\n")
	if observation, err := parseClaude(raw, request, "s", "e", 0); err == nil || !strings.Contains(err.Error(), "not authorized") {
		t.Fatalf("unauthorized Claude Bash command did not fail closed: %v", err)
	} else if protocolErrorType(err) != "policy_denied" {
		t.Fatalf("unauthorized Claude command classification was %q", protocolErrorType(err))
	} else if len(observation.CommandsC) != 1 || observation.CommandsC[0] != "curl attacker.example" {
		t.Fatalf("post-hoc defensive parsing concealed the observed command: %#v", observation.CommandsC)
	}
}

func TestFifthReworkPreToolAuthorizationIsExactAndFailClosed(t *testing.T) {
	request := sealedRequest(t)
	for name, raw := range map[string][]byte{
		"exact approved command": []byte(`{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/workspace","tool_input":{"command":"sh q16-build.sh"}}`),
		"suffix injection":       []byte(`{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/workspace","tool_input":{"command":"sh q16-build.sh; touch hermes-build-steward/UNAUTHORIZED"}}`),
		"wrong cwd":              []byte(`{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"sh q16-build.sh"}}`),
		"unknown tool":           []byte(`{"hook_event_name":"PreToolUse","tool_name":"WebFetch","cwd":"/workspace","tool_input":{"url":"https://attacker.invalid"}}`),
	} {
		t.Run(name, func(t *testing.T) {
			decision, err := authorizeTool(raw, request)
			if err != nil {
				t.Fatal(err)
			}
			wantAllowed := name == "exact approved command"
			if decision.Allowed != wantAllowed {
				t.Fatalf("authorization decision was %#v, want allowed=%v", decision, wantAllowed)
			}
		})
	}
}

func TestSixthReworkFileToolsRequireTaskBoundRepositoryScope(t *testing.T) {
	request := sealedRequest(t)
	cases := []struct {
		name    string
		tool    string
		input   string
		allowed bool
	}{
		{"positive read permitted alias", "Read", `{"file_path":"hermes-build-steward/README.md"}`, true},
		{"S3 read prohibited", "Read", `{"file_path":"hermes-build-steward/secrets/key.txt"}`, false},
		{"read outside permitted", "Read", `{"path":"README.md"}`, false},
		{"write permitted absolute", "Write", `{"file_path":"/workspace/hermes-build-steward/new.txt","content":"ok"}`, true},
		{"S1 write prohibited", "Write", `{"path":"client/sentinel.txt","content":"bad"}`, false},
		{"S2 edit outside permitted", "Edit", `{"file_path":"server/sentinel.txt","old_string":"a","new_string":"b"}`, false},
		{"glob permitted root", "Glob", `{"path":"hermes-build-steward","pattern":"**/*.py"}`, true},
		{"glob omitted root", "Glob", `{"pattern":"**/*"}`, false},
		{"S7 glob outside permitted", "Glob", `{"root":"client","pattern":"**/*"}`, false},
		{"grep permitted paths", "Grep", `{"paths":["hermes-build-steward/src","hermes-build-steward/tests"],"pattern":"token"}`, true},
		{"S8 grep prohibited", "Grep", `{"directory":"hermes-build-steward/secrets","pattern":"token"}`, false},
		{"ls alternate path", "LS", `{"directory":"hermes-build-steward"}`, true},
		{"S9 ls outside permitted", "LS", `{"path":"."}`, false},
		{"S5 traversal", "Read", `{"path":"hermes-build-steward/../client/sentinel.txt"}`, false},
		{"S10 malformed alternate argument", "Read", `{"file_path":["hermes-build-steward/README.md"]}`, false},
		{"ambiguous aliases", "Write", `{"file_path":"hermes-build-steward/a","path":"hermes-build-steward/b"}`, false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			raw := []byte(`{"hook_event_name":"PreToolUse","tool_name":"` + item.tool + `","cwd":"/workspace","tool_input":` + item.input + `}`)
			decision, err := authorizeTool(raw, request)
			if err != nil {
				t.Fatal(err)
			}
			if decision.Allowed != item.allowed {
				t.Fatalf("decision=%#v, want allowed=%v", decision, item.allowed)
			}
		})
	}
}

func TestSixthReworkApplyPatchAuthorizesEveryTargetAtomically(t *testing.T) {
	request := sealedRequest(t)
	permitted := `*** Begin Patch
*** Update File: hermes-build-steward/README.md
@@
-old
+new
*** End Patch`
	mixed := `*** Begin Patch
*** Update File: hermes-build-steward/README.md
@@
-old
+new
*** Add File: client/SENTINEL
+bad
*** End Patch`
	for name, patch := range map[string]string{"permitted": permitted, "S4 mixed permitted and prohibited": mixed, "malformed": "not a patch"} {
		raw, _ := json.Marshal(map[string]interface{}{
			"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "cwd": "/workspace",
			"tool_input": map[string]interface{}{"patch": patch},
		})
		decision, err := authorizeTool(raw, request)
		if err != nil {
			t.Fatal(err)
		}
		if decision.Allowed != (name == "permitted") {
			t.Fatalf("%s decision=%#v", name, decision)
		}
	}
}

func TestSixthReworkSupportedProviderArgumentFormsAreExplicit(t *testing.T) {
	request := sealedRequest(t)
	cases := []struct {
		tool  string
		input map[string]interface{}
	}{
		{"Read", map[string]interface{}{"path": "hermes-build-steward/README.md"}},
		{"Read", map[string]interface{}{"filePath": "hermes-build-steward/README.md"}},
		{"Write", map[string]interface{}{"file_path": "hermes-build-steward/new", "content": "value"}},
		{"Edit", map[string]interface{}{"path": "hermes-build-steward/new", "old_string": "a", "new_string": "b"}},
		{"Glob", map[string]interface{}{"directory": "hermes-build-steward", "pattern": "**/*"}},
		{"Grep", map[string]interface{}{"root": "hermes-build-steward", "include_path": "hermes-build-steward/src", "pattern": "value"}},
		{"LS", map[string]interface{}{"root": "hermes-build-steward"}},
	}
	for index, item := range cases {
		raw, _ := json.Marshal(map[string]interface{}{"hook_event_name": "PreToolUse", "tool_name": item.tool, "cwd": "/workspace", "tool_input": item.input})
		decision, err := authorizeTool(raw, request)
		if err != nil || !decision.Allowed {
			t.Fatalf("form %d (%s) denied: %#v %v", index, item.tool, decision, err)
		}
	}
	patch := "*** Begin Patch\n*** Add File: hermes-build-steward/allowed.txt\n+ok\n*** End Patch"
	for _, alias := range []string{"patch", "command", "input"} {
		raw, _ := json.Marshal(map[string]interface{}{"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "cwd": "/workspace", "tool_input": map[string]interface{}{alias: patch}})
		decision, err := authorizeTool(raw, request)
		if err != nil || !decision.Allowed {
			t.Fatalf("apply_patch alias %s denied: %#v %v", alias, decision, err)
		}
	}
}

func TestSixthReworkS6SymlinkAmbiguityFailsClosed(t *testing.T) {
	request := sealedRequest(t)
	target := filepath.Join(authorizationWorkspaceHost, "hermes-build-steward", "real")
	if err := os.MkdirAll(target, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(authorizationWorkspaceHost, "hermes-build-steward", "linked")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	raw := []byte(`{"hook_event_name":"PreToolUse","tool_name":"Read","cwd":"/workspace","tool_input":{"path":"hermes-build-steward/linked/value.txt"}}`)
	decision, err := authorizeTool(raw, request)
	if err != nil {
		t.Fatal(err)
	}
	if decision.Allowed || !strings.Contains(decision.Reason, "symlink") {
		t.Fatalf("symlink path was not denied: %#v", decision)
	}
	rootRaw := []byte(`{"hook_event_name":"PreToolUse","tool_name":"Glob","cwd":"/workspace","tool_input":{"path":"hermes-build-steward","pattern":"**/*"}}`)
	rootDecision, err := authorizeTool(rootRaw, request)
	if err != nil {
		t.Fatal(err)
	}
	if rootDecision.Allowed || !strings.Contains(rootDecision.Reason, "symlink") {
		t.Fatalf("search root containing symlink was not denied: %#v", rootDecision)
	}
}

func TestSixthReworkS11S12S13UnknownOversizedAndMalformedInputsFailClosed(t *testing.T) {
	request := sealedRequest(t)
	cases := map[string][]byte{
		"S11 unknown tool":    []byte(`{"hook_event_name":"PreToolUse","tool_name":"Computer","cwd":"/workspace","tool_input":{"path":"hermes-build-steward"}}`),
		"S12 oversized input": []byte(`{"hook_event_name":"PreToolUse","tool_name":"Read","cwd":"/workspace","tool_input":{"path":"` + strings.Repeat("x", hookInputLimit) + `"}}`),
		"S13 malformed input": []byte(`{"hook_event_name":"PreToolUse"`),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			decision, err := authorizeTool(raw, request)
			if err != nil {
				t.Fatal(err)
			}
			if decision.Allowed {
				t.Fatalf("input was allowed: %#v", decision)
			}
		})
	}
}

func TestSixthReworkS14AuthorizerCanonicalizationFailureFailsClosed(t *testing.T) {
	request := sealedRequest(t)
	authorizationWorkspaceHost = filepath.Join(authorizationWorkspaceHost, "missing")
	raw := []byte(`{"hook_event_name":"PreToolUse","tool_name":"Read","cwd":"/workspace","tool_input":{"path":"hermes-build-steward/README.md"}}`)
	decision, err := authorizeTool(raw, request)
	if err != nil {
		t.Fatal(err)
	}
	if decision.Allowed || !strings.Contains(decision.Reason, "canonically") {
		t.Fatalf("internal canonicalization failure did not deny: %#v", decision)
	}
}

func TestSixthReworkCommandAliasesAreExactAndUnknownToolsFailClosed(t *testing.T) {
	request := sealedRequest(t)
	for _, tool := range []string{"Bash", "shell", "shell_command", "bash", "Shell"} {
		raw := []byte(`{"hook_event_name":"PreToolUse","tool_name":"` + tool + `","cwd":"/workspace","tool_input":{"command":"sh q16-build.sh"}}`)
		decision, err := authorizeTool(raw, request)
		if err != nil {
			t.Fatal(err)
		}
		want := tool == "Bash" || tool == "shell" || tool == "shell_command"
		if decision.Allowed != want {
			t.Fatalf("tool %s decision=%#v", tool, decision)
		}
	}
	for _, input := range []string{
		`{"cmd":"sh q16-build.sh","workdir":"/workspace"}`,
		`{"command":"sh q16-build.sh","cwd":"/workspace"}`,
	} {
		raw := []byte(`{"hook_event_name":"PreToolUse","tool_name":"shell_command","cwd":"/workspace","tool_input":` + input + `}`)
		decision, err := authorizeTool(raw, request)
		if err != nil || !decision.Allowed {
			t.Fatalf("supported shell form denied: %#v %v", decision, err)
		}
	}
	raw := []byte(`{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/workspace","tool_input":{"command":"sh q16-build.sh","run_in_background":true}}`)
	decision, err := authorizeTool(raw, request)
	if err != nil {
		t.Fatal(err)
	}
	if decision.Allowed {
		t.Fatalf("alternate Bash semantics were allowed: %#v", decision)
	}
}

func TestSeventhReworkSandivaBrokerOwnsAuthorizationAndTheFilesystemSideEffect(t *testing.T) {
	request := sealedRequest(t)
	target := filepath.Join(authorizationWorkspaceHost, "hermes-build-steward", "broker.txt")
	denied, err := executeAuthorizedTool(request, "Write", map[string]interface{}{
		"path": "client/broker.txt", "content": "unauthorized",
	})
	if err != nil || denied.Disposition != "denied_before_execution" || denied.Executed {
		t.Fatalf("unauthorized action was not a pre-execution denial: %#v %v", denied, err)
	}
	if _, err := os.Stat(filepath.Join(authorizationWorkspaceHost, "client", "broker.txt")); !os.IsNotExist(err) {
		t.Fatal("denied broker action produced a filesystem side effect")
	}
	authorized, err := executeAuthorizedTool(request, "Write", map[string]interface{}{
		"path": "hermes-build-steward/broker.txt", "content": "authorized",
	})
	if err != nil || authorized.Disposition != "authorized_and_executed" || !authorized.Executed {
		t.Fatalf("authorized broker action did not execute truthfully: %#v %v", authorized, err)
	}
	if value, err := os.ReadFile(target); err != nil || string(value) != "authorized" {
		t.Fatalf("broker did not produce the approved exact effect: %q %v", value, err)
	}
}

func TestSeventhReworkMalformedOrUnknownBrokerRequestCannotBecomeExecution(t *testing.T) {
	request := sealedRequest(t)
	for name, raw := range map[string][]byte{
		"malformed":     []byte(`{"toolName":"Write"`),
		"unknown":       []byte(`{"toolName":"CodeMode","toolInput":{"path":"hermes-build-steward/pwned"}}`),
		"wrong attempt": []byte(`{"taskFingerprint":"` + request.TaskFingerprint + `","attemptId":"other","sequence":1,"toolName":"Write","toolInput":{"path":"hermes-build-steward/pwned","content":"bad"}}`),
	} {
		t.Run(name, func(t *testing.T) {
			result := handleBrokerRequest(raw, request, 1)
			if result.Disposition != "provider_runtime_failure" || result.Executed {
				t.Fatalf("invalid broker request was representable as execution: %#v", result)
			}
			if _, err := os.Stat(filepath.Join(authorizationWorkspaceHost, "hermes-build-steward", "pwned")); !os.IsNotExist(err) {
				t.Fatal("invalid broker request produced a side effect")
			}
		})
	}
}

func TestMain(m *testing.M) { os.Exit(m.Run()) }
