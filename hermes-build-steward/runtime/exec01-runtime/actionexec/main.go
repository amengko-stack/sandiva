package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const workspace = "/workspace"

func main() {
	if len(os.Args) < 3 || (os.Args[1] != "shell" && os.Args[1] != "patch") {
		fmt.Fprintln(os.Stderr, "action-exec invocation is invalid")
		os.Exit(125)
	}
	scratch := os.Getenv("EXEC01_ACTION_SCRATCH")
	cleanScratch := filepath.Clean(scratch)
	if !strings.HasPrefix(cleanScratch, "/run/exec/action/") || cleanScratch == "/run/exec/action" {
		fmt.Fprintln(os.Stderr, "action-exec scratch identity is invalid")
		os.Exit(125)
	}
	statusPath := filepath.Clean(os.Getenv("EXEC01_ACTION_STATUS"))
	if !strings.HasPrefix(statusPath, "/run/exec/authority/action-status-") {
		fmt.Fprintln(os.Stderr, "action-exec status identity is invalid")
		os.Exit(125)
	}
	os.Exit(runSandboxedAction(os.Args[1], os.Args[2:], cleanScratch, statusPath))
}
