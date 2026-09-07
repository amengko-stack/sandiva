package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func authorize(provider, command string) (bool, error) {
	input, _ := json.Marshal(map[string]interface{}{
		"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": "/workspace",
		"tool_input": map[string]string{"command": command},
	})
	process := exec.Command("/opt/sandiva/bin/exec01-runtime", "authorize", provider)
	process.Stdin = bytes.NewReader(input)
	process.Env = os.Environ()
	raw, err := process.Output()
	if err != nil {
		return false, err
	}
	var result struct {
		Output struct {
			PermissionDecision string `json:"permissionDecision"`
		} `json:"hookSpecificOutput"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return false, fmt.Errorf("pre-tool authorizer returned malformed output")
	}
	return result.Output.PermissionDecision == "allow", nil
}

func probeGateway(provider string, args []string) error {
	token := os.Getenv("EXEC_GATEWAY_SESSION_TOKEN")
	endpoint := os.Getenv("EXECUTOR_GATEWAY_ENDPOINT")
	if token == "" {
		return nil
	}
	model := ""
	for index, value := range args {
		if value == "--model" && index+1 < len(args) {
			model = args[index+1]
		}
	}
	path := "/v1/responses"
	if provider == "claude" {
		path = "/v1/messages"
	}
	body, _ := json.Marshal(map[string]interface{}{"model": model, "input": "synthetic bounded gateway probe"})
	request, err := http.NewRequest("POST", "http://"+endpoint+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 || response.StatusCode != http.StatusOK {
		return fmt.Errorf("gateway probe rejected")
	}
	contentType := strings.Split(response.Header.Get("Content-Type"), ";")[0]
	if contentType == "application/json" {
		var value map[string]interface{}
		if json.Unmarshal(raw, &value) != nil || value["credentialAccepted"] != true {
			return fmt.Errorf("gateway response is not trusted emulator evidence")
		}
	} else if contentType != "text/event-stream" || !bytes.Contains(raw, []byte("\"credentialAccepted\":true")) {
		return fmt.Errorf("gateway response is not trusted emulator evidence")
	}
	return nil
}

func emit(value map[string]interface{}) {
	encoded, _ := json.Marshal(value)
	fmt.Println(string(encoded))
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("synthetic-1.0.0")
		return
	}
	prompt, _ := bufio.NewReader(os.Stdin).ReadBytes(0)
	if len(prompt) == 0 {
		fmt.Fprintln(os.Stderr, "missing bounded build instruction")
		os.Exit(2)
	}
	command := ""
	provider := filepath.Base(os.Args[0])
	if _, err := os.Stat("/workspace/q16-build.sh"); err == nil {
		command = "sh q16-build.sh"
		allowed, err := authorize(provider, command)
		if err != nil || !allowed {
			if provider == "codex" {
				emit(map[string]interface{}{"type": "thread.started", "thread_id": "emulator-thread"})
				emit(map[string]interface{}{"type": "turn.failed", "error": map[string]string{"classification": "policy_denied"}})
			} else {
				emit(map[string]interface{}{"type": "result", "subtype": "error_policy", "is_error": true, "session_id": "emulator-session", "num_turns": 1, "error": map[string]string{"classification": "policy_denied"}})
			}
			os.Exit(1)
		}
		if err := exec.Command("/workspace/q16-build.sh").Run(); err == nil {
			fmt.Fprintln(os.Stderr, "noexec workspace unexpectedly executed a local binary")
			os.Exit(3)
		}
		process := exec.Command("/bin/sh", "/workspace/q16-build.sh")
		process.Dir = "/workspace"
		if output, err := process.CombinedOutput(); err != nil {
			fmt.Fprintln(os.Stderr, string(output))
			os.Exit(3)
		}
		_ = os.WriteFile("/workspace/hermes-build-steward/noexec-probe.txt", []byte("direct-denied;trusted-interpreter-succeeded\n"), 0600)
	}
	_ = os.MkdirAll("/workspace/hermes-build-steward", 0700)
	if err := os.WriteFile("/workspace/hermes-build-steward/provider-prompt.json", prompt, 0600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := probeGateway(provider, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "trusted gateway probe failed")
		os.Exit(5)
	}
	if provider == "codex" {
		emit(map[string]interface{}{"type": "thread.started", "thread_id": "emulator-thread"})
		if command != "" {
			emit(map[string]interface{}{"type": "item.completed", "item": map[string]interface{}{"type": "command_execution", "command": command, "exit_code": 0, "status": "completed"}})
		}
		emit(map[string]interface{}{"type": "turn.completed", "usage": map[string]int{"input_tokens": 1, "output_tokens": 1}})
		return
	}
	if provider == "claude" {
		if command != "" {
			emit(map[string]interface{}{"type": "assistant", "message": map[string]interface{}{"content": []interface{}{map[string]interface{}{"type": "tool_use", "id": "tool-q16", "name": "Bash", "input": map[string]string{"command": command}}}}})
			emit(map[string]interface{}{"type": "user", "message": map[string]interface{}{"content": []interface{}{map[string]interface{}{"type": "tool_result", "tool_use_id": "tool-q16", "is_error": false, "content": "completed"}}}})
		}
		emit(map[string]interface{}{"type": "result", "subtype": "success", "is_error": false, "session_id": "emulator-session", "num_turns": 1})
		return
	}
	os.Exit(4)
}
