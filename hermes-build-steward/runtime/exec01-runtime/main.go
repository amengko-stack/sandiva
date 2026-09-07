package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const workspace = "/workspace"
const outputLimit = 4 * 1024 * 1024
const launcherVersion = "exec01-runtime-v1.1.0"
const denialMarker = "/run/exec/pretool-denied"

var errCommandPolicy = errors.New("executor command policy denied")

func protocolErrorType(err error) string {
	if errors.Is(err, errCommandPolicy) {
		return "policy_denied"
	}
	return "malformed_provider_result"
}

type requestEnvelope struct {
	TaskID                      string                  `json:"taskId"`
	TaskFingerprint             string                  `json:"taskFingerprint"`
	AttemptID                   string                  `json:"attemptId"`
	ExecutorProfile             executorProfileIdentity `json:"executorProfile"`
	ExecutionContent            map[string]interface{}  `json:"executionContent"`
	ExecutionContentFingerprint string                  `json:"executionContentFingerprint"`
	ApprovedCommands            []string                `json:"approvedCommands"`
	PermittedRepositoryAreas    []string                `json:"permittedRepositoryAreas"`
	ProhibitedRepositoryAreas   []string                `json:"prohibitedRepositoryAreas"`
}

type executorProfileIdentity struct {
	ProfileID          string `json:"profileId"`
	ProfileFingerprint string `json:"profileFingerprint"`
	Provider           string `json:"provider"`
}

type observation struct {
	Protocol      string                   `json:"protocol"`
	Status        string                   `json:"status"`
	StopReason    string                   `json:"stop_reason"`
	StartedAt     string                   `json:"started_at"`
	CompletedAt   string                   `json:"completed_at"`
	StartedAtC    string                   `json:"startedAt"`
	CompletedAtC  string                   `json:"completedAt"`
	Commands      []string                 `json:"commands"`
	CommandsC     []string                 `json:"commandsExecuted"`
	Tests         []map[string]interface{} `json:"tests"`
	TestsC        []map[string]interface{} `json:"testOutcomes"`
	ChangedPaths  []string                 `json:"changed_paths"`
	ChangedPathsC []string                 `json:"changedPaths"`
	PatchDigest   interface{}              `json:"patch_digest"`
	PatchDigestC  interface{}              `json:"patchDigest"`
	LogRefs       []string                 `json:"log_refs"`
	EvidenceRefs  []string                 `json:"evidenceReferences"`
	ErrorType     string                   `json:"error_type"`
	ErrorTypeC    string                   `json:"errorType"`
	ThreadID      string                   `json:"thread_id,omitempty"`
	SessionID     string                   `json:"session_id,omitempty"`
	Turns         int                      `json:"num_turns,omitempty"`
}

type boundedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (b *boundedBuffer) Write(value []byte) (int, error) {
	remaining := b.limit - b.buffer.Len()
	if remaining <= 0 || len(value) > remaining {
		return 0, errors.New("provider output exceeds runtime bound")
	}
	return b.buffer.Write(value)
}

func canonical(value interface{}) ([]byte, error) { return json.Marshal(value) }

func loadRequest() (requestEnvelope, []byte, error) {
	var request requestEnvelope
	raw, err := base64.StdEncoding.DecodeString(os.Getenv("EXEC_REQUEST_B64"))
	if err != nil {
		return request, nil, err
	}
	if len(raw) == 0 || len(raw) > 2*1024*1024 {
		return request, nil, errors.New("sealed request size is invalid")
	}
	if err = json.Unmarshal(raw, &request); err != nil {
		return request, nil, err
	}
	if request.TaskID == "" || request.TaskFingerprint == "" || request.AttemptID == "" || request.ExecutorProfile.ProfileID == "" || request.ExecutorProfile.ProfileFingerprint == "" || request.ExecutorProfile.Provider == "" || request.ExecutionContentFingerprint == "" || request.ExecutionContent == nil {
		return request, nil, errors.New("sealed request identity/content is incomplete")
	}
	content, err := canonical(request.ExecutionContent)
	if err != nil {
		return request, nil, err
	}
	digest := sha256.Sum256(content)
	if hex.EncodeToString(digest[:]) != request.ExecutionContentFingerprint {
		return request, nil, errors.New("sealed execution content fingerprint mismatch")
	}
	return request, content, nil
}

func safeTarget(name string) (string, error) {
	clean := filepath.Clean(name)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", errors.New("archive path escapes workspace")
	}
	target := filepath.Join(workspace, clean)
	relative, err := filepath.Rel(workspace, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, "../") {
		return "", errors.New("archive path escapes workspace")
	}
	return target, nil
}

func importTree() error {
	reader := tar.NewReader(os.Stdin)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target, err := safeTarget(header.Name)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0700); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				return err
			}
			output, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(output, reader)
			closeErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			if err := os.Chmod(target, os.FileMode(header.Mode)&0777); err != nil {
				return err
			}
		case tar.TypeSymlink:
			link := filepath.Clean(header.Linkname)
			if filepath.IsAbs(link) || link == ".." || strings.HasPrefix(link, "../") {
				return errors.New("archive symlink escapes workspace")
			}
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
		default:
			return errors.New("unsupported archive entry")
		}
	}
}

func exportTree() error {
	writer := tar.NewWriter(os.Stdout)
	defer writer.Close()
	return filepath.Walk(workspace, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(workspace, path)
		if err != nil {
			return err
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, err = os.Readlink(path)
			if err != nil {
				return err
			}
		}
		header, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(relative)
		if err = writer.WriteHeader(header); err != nil || !info.Mode().IsRegular() {
			return err
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, input)
		closeErr := input.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}

func approved(command string, values []string) bool {
	for _, value := range values {
		if command == value {
			return true
		}
	}
	return false
}

type hookDecision struct {
	Allowed bool
	Reason  string
}

type hookInput struct {
	EventName string                 `json:"hook_event_name"`
	ToolName  string                 `json:"tool_name"`
	Cwd       string                 `json:"cwd"`
	ToolInput map[string]interface{} `json:"tool_input"`
}

func workspacePath(value string) bool {
	if value == "" {
		return false
	}
	clean := filepath.Clean(value)
	if filepath.IsAbs(clean) {
		relative, err := filepath.Rel(workspace, clean)
		return err == nil && relative != ".." && !strings.HasPrefix(relative, "../")
	}
	return clean != ".." && !strings.HasPrefix(clean, "../") && !strings.Contains(clean, `\`)
}

func authorizeTool(raw []byte, request requestEnvelope) (hookDecision, error) {
	var input hookInput
	if len(raw) == 0 || len(raw) > 64*1024 || json.Unmarshal(raw, &input) != nil {
		return hookDecision{Reason: "malformed pre-tool authorization request"}, nil
	}
	if input.EventName != "PreToolUse" || input.Cwd != workspace || input.ToolName == "" || input.ToolInput == nil {
		return hookDecision{Reason: "pre-tool request is not bound to the execution workspace"}, nil
	}
	if input.ToolName == "Bash" {
		command, ok := input.ToolInput["command"].(string)
		if !ok || command == "" || !approved(command, request.ApprovedCommands) {
			return hookDecision{Reason: "command is not in the task-bound exact allowlist"}, nil
		}
		return hookDecision{Allowed: true, Reason: "exact task-bound command authorized"}, nil
	}
	if input.ToolName == "apply_patch" {
		patch, ok := input.ToolInput["command"].(string)
		if !ok || patch == "" || strings.Contains(patch, "../") || strings.Contains(patch, `..\`) {
			return hookDecision{Reason: "patch input is malformed or escapes the workspace"}, nil
		}
		return hookDecision{Allowed: true, Reason: "workspace patch authorized; trusted prepublication inspection remains mandatory"}, nil
	}
	allowedFileTools := map[string]bool{"Read": true, "Edit": true, "Write": true, "Glob": true, "Grep": true, "LS": true}
	if allowedFileTools[input.ToolName] {
		observedPath := false
		for key, value := range input.ToolInput {
			if !strings.Contains(strings.ToLower(key), "path") {
				continue
			}
			path, ok := value.(string)
			if !ok || !workspacePath(path) {
				return hookDecision{Reason: "file tool path escapes the execution workspace"}, nil
			}
			observedPath = true
		}
		if !observedPath && input.ToolName != "Grep" {
			return hookDecision{Reason: "file tool has no bounded workspace path"}, nil
		}
		return hookDecision{Allowed: true, Reason: "workspace-confined file tool authorized"}, nil
	}
	return hookDecision{Reason: "tool is not allowlisted for EXEC-01"}, nil
}

func emitHookDecision(provider string, decision hookDecision) error {
	if provider != "codex" && provider != "claude" {
		return errors.New("hook provider is not allowlisted")
	}
	permission := "deny"
	if decision.Allowed {
		permission = "allow"
	} else {
		if err := os.WriteFile(denialMarker, []byte(decision.Reason+"\n"), 0600); err != nil {
			return errors.New("pre-tool denial could not be durably recorded")
		}
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]interface{}{
		"hookSpecificOutput": map[string]interface{}{
			"hookEventName": "PreToolUse", "permissionDecision": permission,
			"permissionDecisionReason": decision.Reason,
		},
	})
}

func authorize(provider string) error {
	request, _, err := loadRequest()
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 64*1024+1))
	if err != nil || len(raw) > 64*1024 {
		return errors.New("pre-tool authorization input exceeds its bound")
	}
	decision, err := authorizeTool(raw, request)
	if err != nil {
		return err
	}
	return emitHookDecision(provider, decision)
}

func failureType(value interface{}) string {
	known := map[string]string{
		"provider_unavailable":      "provider_unavailable",
		"service_unavailable":       "provider_unavailable",
		"authentication":            "authentication",
		"authentication_error":      "authentication",
		"rate_limit":                "rate_limit",
		"rate_limit_error":          "rate_limit",
		"policy_denied":             "policy_denied",
		"permission_denied":         "policy_denied",
		"resource_limit":            "resource_limit",
		"timeout":                   "timeout",
		"cancelled":                 "cancelled",
		"malformed_provider_result": "malformed_provider_result",
		"internal_error":            "internal_error",
	}
	var visit func(interface{}) string
	visit = func(candidate interface{}) string {
		switch typed := candidate.(type) {
		case map[string]interface{}:
			for _, key := range []string{"classification", "error_type", "code", "type"} {
				if raw, ok := typed[key].(string); ok {
					if normalized, exists := known[strings.ToLower(raw)]; exists {
						return normalized
					}
				}
			}
			for _, key := range []string{"error", "failure"} {
				if nested, exists := typed[key]; exists {
					if normalized := visit(nested); normalized != "internal_error" {
						return normalized
					}
				}
			}
		}
		return "internal_error"
	}
	return visit(value)
}

func parseCodex(raw []byte, request requestEnvelope, started, completed string, exitCode int) (observation, error) {
	result := observation{Protocol: "codex-exec-jsonl-v1", Status: "failed", StartedAt: started, CompletedAt: completed, Commands: []string{}, Tests: []map[string]interface{}{}, ChangedPaths: []string{}, LogRefs: []string{}, ErrorType: "internal_error"}
	terminal := ""
	startedThread := false
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 64*1024), outputLimit)
	for scanner.Scan() {
		var event map[string]interface{}
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			return result, errors.New("malformed Codex JSONL event")
		}
		typeName, _ := event["type"].(string)
		if terminal != "" {
			return result, errors.New("Codex protocol contains an event after its terminal turn")
		}
		if !startedThread && typeName != "thread.started" {
			return result, errors.New("Codex event precedes thread start")
		}
		if typeName == "thread.started" {
			if startedThread {
				return result, errors.New("Codex protocol contains multiple thread start events")
			}
			startedThread = true
			result.ThreadID, _ = event["thread_id"].(string)
		}
		if typeName == "turn.completed" {
			if !startedThread {
				return result, errors.New("Codex terminal turn precedes thread start")
			}
			terminal = "completed"
			result.Status = "completed"
			result.ErrorType = ""
		}
		if typeName == "turn.failed" {
			if !startedThread {
				return result, errors.New("Codex terminal turn precedes thread start")
			}
			terminal = "failed"
			result.Status = "failed"
			result.ErrorType = failureType(event)
		}
		if typeName == "item.completed" {
			item, _ := event["item"].(map[string]interface{})
			command, _ := item["command"].(string)
			exitCode, exitCodeOK := item["exit_code"].(float64)
			status, statusOK := item["status"].(string)
			if item["type"] == "command_execution" {
				if command == "" || !exitCodeOK || !statusOK {
					return result, fmt.Errorf("%w: Codex command observation is malformed", errCommandPolicy)
				}
				result.Commands = append(result.Commands, command)
				testStatus := "FAIL"
				if exitCode == 0 && status == "completed" {
					testStatus = "PASS"
				}
				result.Tests = append(result.Tests, map[string]interface{}{
					"name": "approved command: " + command, "status": testStatus, "command": command,
				})
				if !approved(command, request.ApprovedCommands) {
					return result, fmt.Errorf("%w: Codex observed command is not authorized", errCommandPolicy)
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}
	if terminal == "" {
		return result, errors.New("Codex protocol has no terminal turn event")
	}
	if (terminal == "completed" && exitCode != 0) || (terminal == "failed" && exitCode == 0) {
		return result, errors.New("Codex process exit status contradicts its terminal event")
	}
	return result, nil
}

func parseClaude(raw []byte, request requestEnvelope, started, completed string, exitCode int) (observation, error) {
	result := observation{Protocol: "claude-code-stream-json-v1", StopReason: "error", StartedAtC: started, CompletedAtC: completed, CommandsC: []string{}, TestsC: []map[string]interface{}{}, ChangedPathsC: []string{}, EvidenceRefs: []string{}, ErrorTypeC: "internal_error"}
	terminal := ""
	toolUses := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 64*1024), outputLimit)
	for scanner.Scan() {
		var event map[string]interface{}
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			return result, errors.New("malformed Claude stream-json event")
		}
		if terminal != "" {
			return result, errors.New("Claude protocol contains an event after its terminal result")
		}
		if event["type"] == "result" {
			result.SessionID, _ = event["session_id"].(string)
			if turns, ok := event["num_turns"].(float64); ok && turns >= 0 {
				result.Turns = int(turns)
			}
			subtype, _ := event["subtype"].(string)
			isError, _ := event["is_error"].(bool)
			if subtype == "success" && !isError {
				terminal = "success"
				result.StopReason = "end_turn"
				result.ErrorTypeC = ""
			} else if isError && strings.HasPrefix(subtype, "error") {
				terminal = "error"
				result.ErrorTypeC = failureType(event)
			} else {
				return result, errors.New("Claude terminal result subtype is unknown or contradictory")
			}
		}
		if event["type"] == "assistant" {
			message, _ := event["message"].(map[string]interface{})
			content, _ := message["content"].([]interface{})
			for _, rawItem := range content {
				item, _ := rawItem.(map[string]interface{})
				input, _ := item["input"].(map[string]interface{})
				command, _ := input["command"].(string)
				toolID, _ := item["id"].(string)
				if item["type"] == "tool_use" && toolID != "" {
					if _, exists := toolUses[toolID]; exists {
						return result, errors.New("Claude protocol reused a tool-use identity")
					}
					if item["name"] == "Bash" {
						if command == "" {
							return result, fmt.Errorf("%w: Claude Bash command observation is malformed", errCommandPolicy)
						}
						toolUses[toolID] = command
					} else {
						toolUses[toolID] = ""
					}
				}
			}
		}
		if event["type"] == "user" {
			message, _ := event["message"].(map[string]interface{})
			content, _ := message["content"].([]interface{})
			for _, rawItem := range content {
				item, _ := rawItem.(map[string]interface{})
				toolID, _ := item["tool_use_id"].(string)
				command, exists := toolUses[toolID]
				if item["type"] != "tool_result" {
					continue
				}
				if !exists {
					return result, errors.New("Claude protocol returned an unknown tool-use identity")
				}
				isError, _ := item["is_error"].(bool)
				status := "PASS"
				if isError {
					status = "FAIL"
				}
				if command != "" {
					result.CommandsC = append(result.CommandsC, command)
					result.TestsC = append(result.TestsC, map[string]interface{}{
						"name": "approved command: " + command, "status": status, "command": command,
					})
					if !approved(command, request.ApprovedCommands) {
						return result, fmt.Errorf("%w: Claude observed Bash command is not authorized", errCommandPolicy)
					}
				}
				delete(toolUses, toolID)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}
	if terminal == "" {
		return result, errors.New("Claude protocol has no terminal result event")
	}
	if len(toolUses) != 0 {
		return result, errors.New("Claude protocol has unresolved tool-use identities")
	}
	if (terminal == "success" && exitCode != 0) || (terminal == "error" && exitCode == 0) {
		return result, errors.New("Claude process exit status contradicts its terminal result")
	}
	return result, nil
}

func executeProvider(args []string) error {
	request, prompt, err := loadRequest()
	if err != nil {
		return err
	}
	if len(args) == 0 || (args[0] != "codex" && args[0] != "claude") {
		return errors.New("launcher is not allowlisted")
	}
	launcher := filepath.Join("/opt/sandiva/bin", args[0])
	if err := os.Remove(denialMarker); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("pre-tool authorization state cannot be initialized")
	}
	command := exec.Command(launcher, args[1:]...)
	command.Dir = workspace
	command.Stdin = bytes.NewReader(prompt)
	gateway := "http://" + os.Getenv("EXECUTOR_GATEWAY_ENDPOINT")
	session := os.Getenv("EXEC_GATEWAY_SESSION_TOKEN")
	command.Env = []string{
		"PATH=/opt/sandiva/bin:/usr/local/bin:/usr/bin:/bin", "HOME=/run/exec", "CI=true",
		"LANG=C.UTF-8", "LC_ALL=C.UTF-8",
		"EXECUTOR_GATEWAY_ENDPOINT=" + os.Getenv("EXECUTOR_GATEWAY_ENDPOINT"),
		"EXEC_GATEWAY_SESSION_TOKEN=" + session,
		"EXEC_TASK_FINGERPRINT=" + request.TaskFingerprint,
		"EXEC_ATTEMPT_ID=" + request.AttemptID,
		"EXEC_PROFILE_FINGERPRINT=" + request.ExecutorProfile.ProfileFingerprint,
		"EXEC_REQUEST_B64=" + os.Getenv("EXEC_REQUEST_B64"),
	}
	if args[0] == "codex" {
		command.Env = append(command.Env, "CODEX_HOME=/opt/sandiva/codex", "OPENAI_BASE_URL="+gateway+"/v1", "OPENAI_API_KEY="+session)
	} else {
		command.Env = append(command.Env, "ANTHROPIC_BASE_URL="+gateway, "ANTHROPIC_AUTH_TOKEN="+session, "ANTHROPIC_API_KEY=")
	}
	stdout := &boundedBuffer{limit: outputLimit}
	stderr := &boundedBuffer{limit: 64 * 1024}
	command.Stdout = stdout
	command.Stderr = stderr
	started := time.Now().UTC().Format(time.RFC3339Nano)
	runErr := command.Run()
	completed := time.Now().UTC().Format(time.RFC3339Nano)
	exitCode := 0
	if runErr != nil {
		if exit, ok := runErr.(*exec.ExitError); ok {
			exitCode = exit.ExitCode()
		} else {
			return runErr
		}
	}
	var result observation
	if args[0] == "codex" {
		result, err = parseCodex(stdout.buffer.Bytes(), request, started, completed, exitCode)
	} else {
		result, err = parseClaude(stdout.buffer.Bytes(), request, started, completed, exitCode)
	}
	if err != nil {
		errorType := protocolErrorType(err)
		if args[0] == "codex" {
			result.Status = "failed"
			result.ErrorType = errorType
		} else {
			result.StopReason = "error"
			result.ErrorTypeC = errorType
		}
	}
	if _, markerErr := os.Stat(denialMarker); markerErr == nil {
		if args[0] == "codex" {
			result.Status = "failed"
			result.ErrorType = "policy_denied"
		} else {
			result.StopReason = "error"
			result.ErrorTypeC = "policy_denied"
		}
	} else if !errors.Is(markerErr, os.ErrNotExist) {
		return errors.New("pre-tool authorization state cannot be read")
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func fileDigest(path string) (string, error) {
	input, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer input.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, input); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func attest(args []string) error {
	if len(args) != 4 || (args[0] != "codex" && args[0] != "claude") {
		return errors.New("attestation arguments are invalid")
	}
	launcher := filepath.Join("/opt/sandiva/bin", args[0])
	info, err := os.Stat(launcher)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 {
		return errors.New("executor launcher identity is unavailable")
	}
	executableDigest, err := fileDigest(launcher)
	if err != nil {
		return err
	}
	runtimeDigest, err := fileDigest("/opt/sandiva/bin/exec01-runtime")
	if err != nil {
		return err
	}
	versionOutput, err := exec.Command(launcher, "--version").CombinedOutput()
	if err != nil {
		return errors.New("executor version observation failed")
	}
	value := map[string]string{
		"runtimeWrapperDigest": runtimeDigest, "executableDigest": executableDigest,
		"executableVersion": strings.TrimSpace(string(versionOutput)), "launcherVersion": launcherVersion,
		"model": args[1], "gatewayImplementationDigest": args[2], "gatewayPolicyDigest": args[3],
	}
	return json.NewEncoder(os.Stdout).Encode(value)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: exec01-runtime import|export|execute")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "import":
		err = importTree()
	case "export":
		err = exportTree()
	case "execute":
		args := os.Args[2:]
		if len(args) > 0 && args[0] == "--" {
			args = args[1:]
		}
		err = executeProvider(args)
	case "attest":
		err = attest(os.Args[2:])
	case "authorize":
		if len(os.Args) != 3 {
			err = errors.New("authorize requires one provider")
		} else {
			err = authorize(os.Args[2])
		}
	case "sleep":
		for {
			time.Sleep(time.Hour)
		}
	default:
		err = errors.New("unsupported runtime operation")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
