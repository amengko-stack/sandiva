package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

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
	_ = os.MkdirAll("/workspace/hermes-build-steward", 0700)
	if err := os.WriteFile("/workspace/hermes-build-steward/provider-prompt.json", prompt, 0600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	command := ""
	if _, err := os.Stat("/workspace/q16-build.sh"); err == nil {
		command = "sh q16-build.sh"
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
	provider := filepath.Base(os.Args[0])
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
