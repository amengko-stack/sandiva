package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func sealedRequest(t *testing.T) requestEnvelope {
	t.Helper()
	content := map[string]interface{}{"pmInstruction": "approved", "scope": []interface{}{"hermes-build-steward/**"}}
	rawContent, _ := json.Marshal(content)
	digest := sha256.Sum256(rawContent)
	request := requestEnvelope{TaskID: "Q02", TaskFingerprint: string(make([]byte, 64)), AttemptID: "attempt-q2", ExecutionContent: content, ExecutionContentFingerprint: hex.EncodeToString(digest[:]), ApprovedCommands: []string{"sh q16-build.sh"}}
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

func TestMain(m *testing.M) { os.Exit(m.Run()) }
