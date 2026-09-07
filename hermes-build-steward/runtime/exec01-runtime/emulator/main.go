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

func action(sequence int, tool string, input map[string]interface{}) (map[string]interface{}, error) {
	payload, _ := json.Marshal(map[string]interface{}{
		"sequence": sequence, "toolName": tool, "toolInput": input,
	})
	process := exec.Command("/opt/sandiva/bin/exec01-runtime", "broker-action")
	process.Stdin = bytes.NewReader(payload)
	process.Env = os.Environ()
	raw, err := process.Output()
	if err != nil {
		return nil, err
	}
	var result map[string]interface{}
	if json.Unmarshal(raw, &result) != nil {
		return nil, fmt.Errorf("Sandiva action broker returned malformed output")
	}
	return result, nil
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
	command := "sh q16-build.sh"
	provider := filepath.Base(os.Args[0])
	if bytes.Contains(prompt, []byte("SEVENTH_NO_BROKER_SUCCESS")) {
		if provider == "codex" {
			emit(map[string]interface{}{"type": "thread.started", "thread_id": "bypass"})
			emit(map[string]interface{}{"type": "turn.completed"})
		} else {
			emit(map[string]interface{}{"type": "result", "subtype": "success", "is_error": false, "session_id": "bypass", "num_turns": 1})
		}
		return
	}
	if bytes.Contains(prompt, []byte("SEVENTH_DIRECT_SURFACE")) {
		if os.WriteFile("/workspace/hermes-build-steward/SEVENTH-BYPASS", []byte("bad"), 0600) == nil {
			fmt.Fprintln(os.Stderr, "provider reached the authoritative workspace")
			os.Exit(91)
		}
		if exec.Command("/bin/sh", "-c", "touch /workspace/hermes-build-steward/SEVENTH-PROCESS").Run() == nil {
			fmt.Fprintln(os.Stderr, "provider executed an unbrokered child process")
			os.Exit(92)
		}
		if provider == "codex" {
			emit(map[string]interface{}{"type": "thread.started", "thread_id": "direct-surface"})
			emit(map[string]interface{}{"type": "turn.completed"})
		} else {
			emit(map[string]interface{}{"type": "result", "subtype": "success", "is_error": false, "session_id": "direct-surface", "num_turns": 1})
		}
		return
	}
	if bytes.Contains(prompt, []byte("SEVENTH_UNKNOWN_SURFACE")) {
		_, _ = action(1, "CodeMode", map[string]interface{}{"path": "hermes-build-steward/SEVENTH-CODE-MODE"})
		if provider == "codex" {
			emit(map[string]interface{}{"type": "thread.started", "thread_id": "unknown-surface"})
			emit(map[string]interface{}{"type": "turn.completed"})
		} else {
			emit(map[string]interface{}{"type": "result", "subtype": "success", "is_error": false, "session_id": "unknown-surface", "num_turns": 1})
		}
		return
	}
	execution, actionErr := action(1, "Bash", map[string]interface{}{"command": command, "cwd": "/workspace"})
	if actionErr != nil || execution["disposition"] != "authorized_and_executed" {
		if execution != nil && execution["disposition"] == "denied_before_execution" {
			if provider == "codex" {
				emit(map[string]interface{}{"type": "thread.started", "thread_id": "emulator-thread"})
				emit(map[string]interface{}{"type": "turn.failed", "error": map[string]string{"classification": "policy_denied"}})
			} else {
				emit(map[string]interface{}{"type": "result", "subtype": "error_policy", "is_error": true, "session_id": "emulator-session", "num_turns": 1, "error": map[string]string{"classification": "policy_denied"}})
			}
			os.Exit(1)
		}
		fmt.Fprintln(os.Stderr, "Sandiva action broker failed")
		os.Exit(3)
	}
	if written, err := action(2, "Write", map[string]interface{}{"path": "hermes-build-steward/provider-prompt.json", "content": string(prompt)}); err != nil || written["disposition"] != "authorized_and_executed" {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if written, err := action(3, "Write", map[string]interface{}{"path": "hermes-build-steward/noexec-probe.txt", "content": "direct-denied;trusted-interpreter-succeeded\n"}); err != nil || written["disposition"] != "authorized_and_executed" {
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
