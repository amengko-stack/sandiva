package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const workspace = "/workspace"
const outputLimit = 4 * 1024 * 1024
const launcherVersion = "exec01-runtime-v1.3.0"
const denialMarker = "/run/exec/authority/pretool-denied"
const brokerSocket = "/run/exec/provider/action.sock"
const brokerLedger = "/run/exec/authority/action-ledger.jsonl"
const brokerReady = "/run/exec/authority/action-ready"
const hookInputLimit = 64 * 1024

// authorizationWorkspaceHost is compile-time fixed to the isolated attempt
// workspace in production. Tests replace it only inside this package so that
// canonical-path checks can run on every supported development OS.
var authorizationWorkspaceHost = workspace
var runtimeExecutablePath = "/opt/sandiva/bin/exec01-runtime"

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
	AuditProvenanceID           string                  `json:"auditProvenanceId"`
	ExecutorProfile             executorProfileIdentity `json:"executorProfile"`
	ExecutionContent            map[string]interface{}  `json:"executionContent"`
	ExecutionContentFingerprint string                  `json:"executionContentFingerprint"`
	ObservedExecutorIdentity    observedIdentity        `json:"observedExecutorIdentity"`
	ApprovedCommands            []string                `json:"approvedCommands"`
	PermittedRepositoryAreas    []string                `json:"permittedRepositoryAreas"`
	ProhibitedRepositoryAreas   []string                `json:"prohibitedRepositoryAreas"`
}

type observedIdentity struct {
	RuntimeWrapperDigest string `json:"runtimeWrapperDigest"`
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
	observedRuntimeDigest, digestErr := fileDigest(runtimeExecutablePath)
	if digestErr != nil || request.ObservedExecutorIdentity.RuntimeWrapperDigest != observedRuntimeDigest {
		return request, nil, errors.New("sealed request runtime authorization-policy identity mismatch")
	}
	if len(request.PermittedRepositoryAreas) == 0 || len(request.ProhibitedRepositoryAreas) == 0 || len(request.ApprovedCommands) == 0 {
		return request, nil, errors.New("sealed request execution authority is incomplete")
	}
	seenCommands := map[string]bool{}
	for _, command := range request.ApprovedCommands {
		if command == "" || command != strings.TrimSpace(command) || seenCommands[command] {
			return request, nil, errors.New("sealed request command authority is malformed")
		}
		seenCommands[command] = true
	}
	for _, patterns := range [][]string{request.PermittedRepositoryAreas, request.ProhibitedRepositoryAreas} {
		seenPatterns := map[string]bool{}
		for _, pattern := range patterns {
			if !validAuthorityPattern(pattern) || seenPatterns[pattern] {
				return request, nil, errors.New("sealed request repository authority is malformed")
			}
			seenPatterns[pattern] = true
		}
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

type toolExecution struct {
	Disposition string      `json:"disposition"`
	Executed    bool        `json:"executed"`
	ToolName    string      `json:"toolName,omitempty"`
	Command     string      `json:"command,omitempty"`
	ExitCode    int         `json:"exitCode,omitempty"`
	Output      interface{} `json:"output,omitempty"`
	Reason      string      `json:"reason,omitempty"`
}

type brokerRequest struct {
	CapabilityToken string                 `json:"capabilityToken"`
	TaskFingerprint string                 `json:"taskFingerprint"`
	AttemptID       string                 `json:"attemptId"`
	Sequence        int                    `json:"sequence"`
	ToolName        string                 `json:"toolName"`
	ToolInput       map[string]interface{} `json:"toolInput"`
}

func validAuthorityPattern(value string) bool {
	if value == "" || value != strings.TrimSpace(value) || strings.ContainsAny(value, "\\\x00") || strings.HasPrefix(value, "/") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func pathMatches(value, pattern string) bool {
	if strings.HasSuffix(pattern, "/**") {
		prefix := strings.TrimSuffix(pattern, "/**")
		return value == prefix || strings.HasPrefix(value, prefix+"/")
	}
	// Python fnmatchcase, used by the canonical task validator and trusted
	// prepublication inspector, lets '*' match '/'. Replacing the separator
	// before Go's path.Match preserves that exact authority semantics.
	matched, err := pathpkg.Match(
		strings.ReplaceAll(pattern, "/", "\x1f"),
		strings.ReplaceAll(value, "/", "\x1f"),
	)
	return err == nil && matched
}

func repositoryPath(value string) (string, error) {
	if value == "" || value != strings.TrimSpace(value) || strings.ContainsAny(value, "\\\x00") {
		return "", errors.New("repository path is malformed")
	}
	original := value
	if value == workspace {
		value = "."
	} else if strings.HasPrefix(value, workspace+"/") {
		value = strings.TrimPrefix(value, workspace+"/")
	} else if strings.HasPrefix(value, "/") {
		return "", errors.New("repository path escapes the execution workspace")
	}
	for _, part := range strings.Split(original, "/") {
		if part == ".." {
			return "", errors.New("repository path traversal is denied")
		}
	}
	clean := pathpkg.Clean(value)
	if clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
		return "", errors.New("repository path escapes the execution workspace")
	}
	return clean, nil
}

func hasAmbiguousSymlink(relative string) (bool, error) {
	rootInfo, err := os.Lstat(authorizationWorkspaceHost)
	if err != nil {
		return false, errors.New("execution workspace cannot be canonically resolved")
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return true, nil
	}
	if relative == "." {
		return false, nil
	}
	current := authorizationWorkspaceHost
	for _, part := range strings.Split(relative, "/") {
		current = filepath.Join(current, filepath.FromSlash(part))
		info, statErr := os.Lstat(current)
		if errors.Is(statErr, os.ErrNotExist) {
			return false, nil
		}
		if statErr != nil {
			return false, errors.New("repository path cannot be canonically resolved")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return true, nil
		}
	}
	return false, nil
}

func treeHasAmbiguousSymlink(relative string) (bool, error) {
	target := authorizationWorkspaceHost
	if relative != "." {
		target = filepath.Join(target, filepath.FromSlash(relative))
	}
	info, err := os.Lstat(target)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, errors.New("search root cannot be canonically resolved")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return true, nil
	}
	if !info.IsDir() {
		return false, nil
	}
	entries := 0
	err = filepath.WalkDir(target, func(_ string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > 100000 {
			return errors.New("search root canonicalization exceeds its bound")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errAmbiguousSearchSymlink
		}
		return nil
	})
	if errors.Is(err, errAmbiguousSearchSymlink) {
		return true, nil
	}
	if err != nil {
		return false, errors.New("search root cannot be canonically resolved")
	}
	return false, nil
}

var errAmbiguousSearchSymlink = errors.New("search root contains a symlink")

func authorizeRepositoryPath(value string, request requestEnvelope) error {
	relative, err := repositoryPath(value)
	if err != nil {
		return err
	}
	if len(request.PermittedRepositoryAreas) == 0 {
		return errors.New("task has no permitted repository area")
	}
	for _, pattern := range append(append([]string{}, request.PermittedRepositoryAreas...), request.ProhibitedRepositoryAreas...) {
		if !validAuthorityPattern(pattern) {
			return errors.New("task repository authority pattern is malformed")
		}
	}
	for _, pattern := range request.ProhibitedRepositoryAreas {
		if pathMatches(relative, pattern) {
			return errors.New("repository path is prohibited by the sealed task")
		}
	}
	permitted := false
	for _, pattern := range request.PermittedRepositoryAreas {
		if pathMatches(relative, pattern) {
			permitted = true
			break
		}
	}
	if !permitted {
		return errors.New("repository path is outside the sealed task permission envelope")
	}
	ambiguous, err := hasAmbiguousSymlink(relative)
	if err != nil {
		return err
	}
	if ambiguous {
		return errors.New("repository path contains a symlink or canonical-path ambiguity")
	}
	return nil
}

func pathValues(input map[string]interface{}, aliases []string, multipleAliases map[string]bool, recognizedAliases ...string) ([]string, error) {
	allowed := map[string]bool{}
	if len(recognizedAliases) == 0 {
		recognizedAliases = aliases
	}
	for _, alias := range recognizedAliases {
		allowed[alias] = true
	}
	for key := range input {
		lower := strings.ToLower(key)
		if (strings.Contains(lower, "path") || lower == "directory" || lower == "root" || lower == "cwd") && !allowed[key] {
			return nil, errors.New("file tool contains an unsupported path argument")
		}
	}
	values := []string{}
	observedAlias := ""
	for _, alias := range aliases {
		raw, exists := input[alias]
		if !exists {
			continue
		}
		if observedAlias != "" {
			return nil, errors.New("file tool contains ambiguous path aliases")
		}
		observedAlias = alias
		if multipleAliases[alias] {
			items, ok := raw.([]interface{})
			if !ok || len(items) == 0 {
				return nil, errors.New("file tool path list is malformed")
			}
			for _, item := range items {
				value, ok := item.(string)
				if !ok || value == "" {
					return nil, errors.New("file tool path list is malformed")
				}
				values = append(values, value)
			}
		} else {
			value, ok := raw.(string)
			if !ok || value == "" {
				return nil, errors.New("file tool path is malformed")
			}
			values = append(values, value)
		}
	}
	if len(values) == 0 {
		return nil, errors.New("file tool has no explicit bounded repository path")
	}
	return values, nil
}

func validateSearchPattern(tool string, input map[string]interface{}) error {
	keys := []string{"pattern"}
	if tool == "Grep" {
		keys = []string{"glob"}
	}
	for _, key := range keys {
		raw, exists := input[key]
		if !exists {
			continue
		}
		value, ok := raw.(string)
		if !ok || value == "" || strings.ContainsAny(value, "\\\x00") || strings.HasPrefix(value, "/") {
			return errors.New("search pattern is malformed")
		}
		for _, part := range strings.Split(value, "/") {
			if part == ".." {
				return errors.New("search pattern traversal is denied")
			}
		}
	}
	return nil
}

func exactToolKeys(input map[string]interface{}, allowed ...string) error {
	keys := map[string]bool{}
	for _, key := range allowed {
		keys[key] = true
	}
	for key := range input {
		if !keys[key] {
			return errors.New("tool input contains an unsupported argument")
		}
	}
	return nil
}

func patchTargets(patch string) ([]string, error) {
	if patch == "" || strings.ContainsRune(patch, '\x00') {
		return nil, errors.New("patch input is malformed")
	}
	normalizedPatch := strings.ReplaceAll(patch, "\r\n", "\n")
	lines := strings.Split(normalizedPatch, "\n")
	targets := []string{}
	custom := false
	standard := false
	standardOld := 0
	standardNew := 0
	for _, line := range lines {
		for _, prefix := range []string{"*** Update File: ", "*** Add File: ", "*** Delete File: ", "*** Move to: "} {
			if strings.HasPrefix(line, prefix) {
				custom = true
				target := strings.TrimSpace(strings.TrimPrefix(line, prefix))
				if target == "" {
					return nil, errors.New("patch target is malformed")
				}
				targets = append(targets, target)
			}
		}
		if strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ ") {
			standard = true
			if strings.HasPrefix(line, "--- ") {
				standardOld++
			} else {
				standardNew++
			}
			target := strings.TrimSpace(line[4:])
			if tab := strings.IndexByte(target, '\t'); tab >= 0 {
				target = target[:tab]
			}
			if target == "/dev/null" {
				continue
			}
			if strings.HasPrefix(target, "a/") || strings.HasPrefix(target, "b/") {
				target = target[2:]
			}
			if target == "" {
				return nil, errors.New("patch target is malformed")
			}
			targets = append(targets, target)
		}
	}
	if len(targets) == 0 || (custom && (!strings.HasPrefix(normalizedPatch, "*** Begin Patch\n") || !strings.HasSuffix(strings.TrimSpace(normalizedPatch), "*** End Patch"))) || (custom && standard) || (standard && (standardOld == 0 || standardOld != standardNew)) {
		return nil, errors.New("patch input is malformed")
	}
	return targets, nil
}

func authorizeTool(raw []byte, request requestEnvelope) (hookDecision, error) {
	var input hookInput
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	decodeErr := decoder.Decode(&input)
	var trailing interface{}
	trailingErr := decoder.Decode(&trailing)
	if len(raw) == 0 || len(raw) > hookInputLimit || decodeErr != nil || !errors.Is(trailingErr, io.EOF) {
		return hookDecision{Reason: "malformed pre-tool authorization request"}, nil
	}
	if input.EventName != "PreToolUse" || input.Cwd != workspace || input.ToolName == "" || input.ToolInput == nil {
		return hookDecision{Reason: "pre-tool request is not bound to the execution workspace"}, nil
	}
	if input.ToolName == "Bash" || input.ToolName == "shell" || input.ToolName == "shell_command" {
		if err := exactToolKeys(input.ToolInput, "command", "cmd", "cwd", "workdir"); err != nil {
			return hookDecision{Reason: err.Error()}, nil
		}
		command := ""
		observedCommandAlias := false
		for _, key := range []string{"command", "cmd"} {
			if rawCommand, exists := input.ToolInput[key]; exists {
				if observedCommandAlias {
					return hookDecision{Reason: "shell input contains ambiguous command aliases"}, nil
				}
				observedCommandAlias = true
				var ok bool
				command, ok = rawCommand.(string)
				if !ok {
					return hookDecision{Reason: "shell command is malformed"}, nil
				}
			}
		}
		observedDirectoryAlias := false
		for _, key := range []string{"cwd", "workdir"} {
			if rawDirectory, exists := input.ToolInput[key]; exists {
				if observedDirectoryAlias {
					return hookDecision{Reason: "shell input contains ambiguous workspace aliases"}, nil
				}
				observedDirectoryAlias = true
				directory, ok := rawDirectory.(string)
				if !ok || directory != workspace {
					return hookDecision{Reason: "shell workdir is outside the execution workspace"}, nil
				}
			}
		}
		ok := observedCommandAlias
		if !ok || command == "" || !approved(command, request.ApprovedCommands) {
			return hookDecision{Reason: "command is not in the task-bound exact allowlist"}, nil
		}
		return hookDecision{Allowed: true, Reason: "exact task-bound command authorized"}, nil
	}
	if input.ToolName == "apply_patch" {
		if err := exactToolKeys(input.ToolInput, "patch", "command", "input"); err != nil {
			return hookDecision{Reason: err.Error()}, nil
		}
		var patch string
		observedPatchAlias := false
		for _, key := range []string{"patch", "command", "input"} {
			if rawPatch, exists := input.ToolInput[key]; exists {
				if observedPatchAlias {
					return hookDecision{Reason: "patch input contains ambiguous aliases"}, nil
				}
				observedPatchAlias = true
				var ok bool
				patch, ok = rawPatch.(string)
				if !ok {
					return hookDecision{Reason: "patch input is malformed"}, nil
				}
			}
		}
		targets, err := patchTargets(patch)
		if err != nil {
			return hookDecision{Reason: err.Error()}, nil
		}
		for _, target := range targets {
			if err := authorizeRepositoryPath(target, request); err != nil {
				return hookDecision{Reason: "patch target denied: " + err.Error()}, nil
			}
		}
		return hookDecision{Allowed: true, Reason: "every patch target is authorized by the sealed task"}, nil
	}
	toolAliases := map[string][]string{
		"Read": {"file_path", "path", "filePath"}, "Write": {"file_path", "path", "filePath"},
		"Edit": {"file_path", "path", "filePath"}, "Glob": {"path", "directory", "root"},
		"Grep": {"path", "paths", "directory", "root", "include_path", "include_paths"},
		"LS":   {"path", "directory", "root"},
	}
	aliases, fileTool := toolAliases[input.ToolName]
	if fileTool {
		allowedKeys := map[string][]string{
			"Read":  {"file_path", "path", "filePath", "offset", "limit"},
			"Write": {"file_path", "path", "filePath", "content"},
			"Edit":  {"file_path", "path", "filePath", "old_string", "new_string", "replace_all"},
			"Glob":  {"path", "directory", "root", "pattern"},
			"Grep":  {"path", "paths", "directory", "root", "include_path", "include_paths", "pattern", "glob", "output_mode", "head_limit"},
			"LS":    {"path", "directory", "root"},
		}
		if err := exactToolKeys(input.ToolInput, allowedKeys[input.ToolName]...); err != nil {
			return hookDecision{Reason: err.Error()}, nil
		}
		if input.ToolName == "Write" {
			if _, ok := input.ToolInput["content"].(string); !ok {
				return hookDecision{Reason: "Write content is malformed"}, nil
			}
		}
		if input.ToolName == "Edit" {
			if _, ok := input.ToolInput["old_string"].(string); !ok {
				return hookDecision{Reason: "Edit old_string is malformed"}, nil
			}
			if _, ok := input.ToolInput["new_string"].(string); !ok {
				return hookDecision{Reason: "Edit new_string is malformed"}, nil
			}
		}
		if input.ToolName == "Grep" {
			if pattern, ok := input.ToolInput["pattern"].(string); !ok || pattern == "" {
				return hookDecision{Reason: "Grep pattern is malformed"}, nil
			}
		}
		recognized := aliases
		if input.ToolName == "Grep" {
			recognized = append(append([]string{}, aliases...), "include_path", "include_paths")
			aliases = []string{"path", "paths", "directory", "root"}
		}
		values, err := pathValues(input.ToolInput, aliases, map[string]bool{"paths": true}, recognized...)
		if err != nil {
			return hookDecision{Reason: err.Error()}, nil
		}
		if input.ToolName == "Grep" {
			supplemental := map[string]interface{}{}
			for _, key := range []string{"include_path", "include_paths"} {
				if value, exists := input.ToolInput[key]; exists {
					supplemental[key] = value
				}
			}
			if len(supplemental) != 0 {
				additional, supplementalErr := pathValues(
					supplemental, []string{"include_path", "include_paths"},
					map[string]bool{"include_paths": true},
				)
				if supplementalErr != nil {
					return hookDecision{Reason: supplementalErr.Error()}, nil
				}
				values = append(values, additional...)
			}
		}
		if input.ToolName == "Glob" || input.ToolName == "Grep" {
			if err := validateSearchPattern(input.ToolName, input.ToolInput); err != nil {
				return hookDecision{Reason: err.Error()}, nil
			}
		}
		for _, value := range values {
			if err := authorizeRepositoryPath(value, request); err != nil {
				return hookDecision{Reason: "file tool path denied: " + err.Error()}, nil
			}
			if input.ToolName == "Glob" || input.ToolName == "Grep" || input.ToolName == "LS" {
				relative, _ := repositoryPath(value)
				ambiguous, treeErr := treeHasAmbiguousSymlink(relative)
				if treeErr != nil || ambiguous {
					return hookDecision{Reason: "search/list root contains a symlink or canonical-path ambiguity"}, nil
				}
			}
		}
		return hookDecision{Allowed: true, Reason: "every file tool path is authorized by the sealed task"}, nil
	}
	return hookDecision{Reason: "tool is not allowlisted for EXEC-01"}, nil
}

func toolHostPath(value string) (string, error) {
	relative, err := repositoryPath(value)
	if err != nil {
		return "", err
	}
	if relative == "." {
		return authorizationWorkspaceHost, nil
	}
	return filepath.Join(authorizationWorkspaceHost, filepath.FromSlash(relative)), nil
}

func toolString(input map[string]interface{}, names ...string) (string, bool) {
	for _, name := range names {
		if raw, ok := input[name]; ok {
			value, valid := raw.(string)
			return value, valid
		}
	}
	return "", false
}

func executeAuthorizedTool(request requestEnvelope, tool string, input map[string]interface{}) (toolExecution, error) {
	result := toolExecution{Disposition: "provider_runtime_failure", ToolName: tool}
	raw, err := json.Marshal(hookInput{EventName: "PreToolUse", ToolName: tool, Cwd: workspace, ToolInput: input})
	if err != nil {
		result.Reason = "action could not be normalized"
		return result, nil
	}
	decision, err := authorizeTool(raw, request)
	if err != nil {
		result.Reason = "Sandiva authorizer failed closed"
		return result, nil
	}
	if !decision.Allowed {
		result.Disposition = "denied_before_execution"
		result.Reason = decision.Reason
		return result, nil
	}

	fail := func(actionErr error) (toolExecution, error) {
		result.Executed = true
		result.Reason = actionErr.Error()
		return result, nil
	}
	succeed := func(output interface{}) (toolExecution, error) {
		result.Disposition = "authorized_and_executed"
		result.Executed = true
		result.Output = output
		return result, nil
	}

	switch tool {
	case "Bash", "shell", "shell_command":
		commandValue, ok := toolString(input, "command", "cmd")
		if !ok {
			return fail(errors.New("authorized shell command could not be resolved"))
		}
		result.Command = commandValue
		process := exec.Command("/bin/sh", "-c", commandValue)
		process.Dir = authorizationWorkspaceHost
		process.Env = []string{"PATH=/opt/sandiva/bin:/usr/local/bin:/usr/bin:/bin", "HOME=/run/exec", "CI=true", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
		stdout := &boundedBuffer{limit: 512 * 1024}
		stderr := &boundedBuffer{limit: 64 * 1024}
		process.Stdout, process.Stderr = stdout, stderr
		runErr := process.Run()
		output := map[string]interface{}{"stdout": stdout.buffer.String(), "stderr": stderr.buffer.String(), "exitCode": 0}
		if runErr != nil {
			if exit, ok := runErr.(*exec.ExitError); ok {
				result.ExitCode = exit.ExitCode()
				output["exitCode"] = result.ExitCode
				return succeed(output)
			}
			return fail(runErr)
		}
		return succeed(output)
	case "Read":
		value, _ := toolString(input, "file_path", "path", "filePath")
		target, pathErr := toolHostPath(value)
		if pathErr != nil {
			return fail(pathErr)
		}
		file, openErr := os.Open(target)
		if openErr != nil {
			return fail(openErr)
		}
		defer file.Close()
		content, readErr := io.ReadAll(io.LimitReader(file, 512*1024+1))
		if readErr != nil || len(content) > 512*1024 {
			return fail(errors.New("read result exceeds its bound"))
		}
		return succeed(string(content))
	case "Write":
		value, _ := toolString(input, "file_path", "path", "filePath")
		content, _ := toolString(input, "content")
		target, pathErr := toolHostPath(value)
		if pathErr != nil {
			return fail(pathErr)
		}
		if mkdirErr := os.MkdirAll(filepath.Dir(target), 0700); mkdirErr != nil {
			return fail(mkdirErr)
		}
		temporary, createErr := os.CreateTemp(filepath.Dir(target), ".exec01-write-*")
		if createErr != nil {
			return fail(createErr)
		}
		temporaryName := temporary.Name()
		defer os.Remove(temporaryName)
		if chmodErr := temporary.Chmod(0600); chmodErr != nil {
			temporary.Close()
			return fail(chmodErr)
		}
		if _, writeErr := temporary.WriteString(content); writeErr != nil {
			temporary.Close()
			return fail(writeErr)
		}
		if closeErr := temporary.Close(); closeErr != nil {
			return fail(closeErr)
		}
		if renameErr := os.Rename(temporaryName, target); renameErr != nil {
			return fail(renameErr)
		}
		return succeed(map[string]interface{}{"bytesWritten": len(content)})
	case "Edit":
		value, _ := toolString(input, "file_path", "path", "filePath")
		oldValue, _ := toolString(input, "old_string")
		newValue, _ := toolString(input, "new_string")
		target, pathErr := toolHostPath(value)
		if pathErr != nil {
			return fail(pathErr)
		}
		content, readErr := os.ReadFile(target)
		if readErr != nil || len(content) > 2*1024*1024 {
			return fail(errors.New("edit target is unavailable or exceeds its bound"))
		}
		replaceAll, _ := input["replace_all"].(bool)
		count := bytes.Count(content, []byte(oldValue))
		if count == 0 || (!replaceAll && count != 1) {
			return fail(errors.New("edit match is absent or ambiguous"))
		}
		replaced := bytes.Replace(content, []byte(oldValue), []byte(newValue), 1)
		if replaceAll {
			replaced = bytes.ReplaceAll(content, []byte(oldValue), []byte(newValue))
		}
		if writeErr := os.WriteFile(target, replaced, 0600); writeErr != nil {
			return fail(writeErr)
		}
		return succeed(map[string]interface{}{"replacements": count})
	case "LS":
		value, _ := toolString(input, "path", "directory", "root")
		target, pathErr := toolHostPath(value)
		if pathErr != nil {
			return fail(pathErr)
		}
		entries, readErr := os.ReadDir(target)
		if readErr != nil {
			return fail(readErr)
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		sort.Strings(names)
		return succeed(names)
	case "Glob":
		value, _ := toolString(input, "path", "directory", "root")
		pattern, _ := toolString(input, "pattern")
		target, pathErr := toolHostPath(value)
		if pathErr != nil {
			return fail(pathErr)
		}
		matches, globErr := filepath.Glob(filepath.Join(target, filepath.FromSlash(pattern)))
		if globErr != nil {
			return fail(globErr)
		}
		for index, match := range matches {
			relative, _ := filepath.Rel(authorizationWorkspaceHost, match)
			matches[index] = filepath.ToSlash(relative)
		}
		sort.Strings(matches)
		return succeed(matches)
	case "Grep":
		value, _ := toolString(input, "path", "directory", "root")
		pattern, _ := toolString(input, "pattern")
		target, pathErr := toolHostPath(value)
		if pathErr != nil {
			return fail(pathErr)
		}
		matches := []string{}
		walkErr := filepath.WalkDir(target, func(candidate string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			content, readErr := os.ReadFile(candidate)
			if readErr != nil || len(content) > 512*1024 {
				return nil
			}
			if bytes.Contains(content, []byte(pattern)) {
				relative, _ := filepath.Rel(authorizationWorkspaceHost, candidate)
				matches = append(matches, filepath.ToSlash(relative))
			}
			if len(matches) > 10000 {
				return errors.New("grep result exceeds its bound")
			}
			return nil
		})
		if walkErr != nil {
			return fail(walkErr)
		}
		sort.Strings(matches)
		return succeed(matches)
	case "apply_patch":
		patchValue, _ := toolString(input, "patch", "command", "input")
		if strings.HasPrefix(strings.ReplaceAll(patchValue, "\r\n", "\n"), "*** Begin Patch\n") {
			return fail(errors.New("custom patch execution is not supported by the trusted broker"))
		}
		for _, arguments := range [][]string{{"--dry-run", "-p1", "--forward", "--batch"}, {"-p1", "--forward", "--batch"}} {
			process := exec.Command("/usr/bin/patch", arguments...)
			process.Dir = authorizationWorkspaceHost
			process.Env = []string{"PATH=/usr/bin:/bin", "HOME=/run/exec", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
			process.Stdin = strings.NewReader(patchValue)
			output := &boundedBuffer{limit: 128 * 1024}
			process.Stdout, process.Stderr = output, output
			if runErr := process.Run(); runErr != nil {
				return fail(errors.New("trusted patch execution failed"))
			}
		}
		return succeed(map[string]interface{}{"patchDigest": fmt.Sprintf("%x", sha256.Sum256([]byte(patchValue)))})
	default:
		result.Reason = "tool is not implemented by the Sandiva action broker"
		return result, nil
	}
}

func handleBrokerRequest(raw []byte, request requestEnvelope, expectedSequence int) toolExecution {
	failed := toolExecution{Disposition: "provider_runtime_failure", Reason: "broker request failed closed"}
	if len(raw) == 0 || len(raw) > hookInputLimit {
		return failed
	}
	var action brokerRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&action); err != nil {
		return failed
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return failed
	}
	if action.TaskFingerprint != request.TaskFingerprint || action.AttemptID != request.AttemptID || action.Sequence != expectedSequence || action.ToolName == "" || action.ToolInput == nil {
		return failed
	}
	result, err := executeAuthorizedTool(request, action.ToolName, action.ToolInput)
	if err != nil {
		return failed
	}
	return result
}

func appendBrokerLedger(sequence int, result toolExecution) error {
	entry, err := json.Marshal(map[string]interface{}{
		"sequence": sequence, "occurredAt": time.Now().UTC().Format(time.RFC3339Nano),
		"disposition": result.Disposition, "executed": result.Executed,
		"toolName": result.ToolName, "command": result.Command, "exitCode": result.ExitCode, "reason": result.Reason,
	})
	if err != nil {
		return err
	}
	file, err := os.OpenFile(brokerLedger, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(entry, '\n'))
	return err
}

func serveBroker() error {
	request, _, err := loadRequest()
	if err != nil {
		return err
	}
	token := os.Getenv("EXEC_ACTION_CAPABILITY")
	if len(token) < 32 {
		return errors.New("action capability is absent")
	}
	_ = os.Remove(brokerSocket)
	listener, err := net.Listen("unix", brokerSocket)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err := os.Chmod(brokerSocket, 0600); err != nil {
		return err
	}
	if err := os.WriteFile(brokerLedger, nil, 0600); err != nil {
		return err
	}
	if err := os.WriteFile(brokerReady, []byte("ready\n"), 0600); err != nil {
		return err
	}
	sequence := 1
	for {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return acceptErr
		}
		_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
		raw, readErr := io.ReadAll(io.LimitReader(connection, hookInputLimit+1))
		result := toolExecution{Disposition: "provider_runtime_failure", Reason: "broker transport failed closed"}
		if readErr == nil && len(raw) <= hookInputLimit {
			var authentication struct {
				CapabilityToken string `json:"capabilityToken"`
			}
			if json.Unmarshal(raw, &authentication) == nil && authentication.CapabilityToken == token {
				result = handleBrokerRequest(raw, request, sequence)
			}
		}
		if result.Disposition != "provider_runtime_failure" || result.ToolName != "" {
			if ledgerErr := appendBrokerLedger(sequence, result); ledgerErr != nil {
				result = toolExecution{Disposition: "provider_runtime_failure", Reason: "broker provenance persistence failed closed"}
			}
			sequence++
		}
		_ = json.NewEncoder(connection).Encode(result)
		_ = connection.Close()
	}
}

func brokerAction() error {
	request, _, err := loadRequest()
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, hookInputLimit+1))
	if err != nil || len(raw) > hookInputLimit {
		return errors.New("broker action exceeds its bound")
	}
	var action brokerRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&action); err != nil {
		return errors.New("broker action is malformed")
	}
	action.TaskFingerprint = request.TaskFingerprint
	action.AttemptID = request.AttemptID
	action.CapabilityToken = os.Getenv("EXEC_ACTION_CAPABILITY")
	encoded, err := json.Marshal(action)
	if err != nil {
		return err
	}
	connection, err := net.DialTimeout("unix", brokerSocket, 2*time.Second)
	if err != nil {
		return errors.New("Sandiva action broker is unavailable")
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := connection.Write(encoded); err != nil {
		return err
	}
	if unix, ok := connection.(*net.UnixConn); ok {
		_ = unix.CloseWrite()
	}
	response, err := io.ReadAll(io.LimitReader(connection, hookInputLimit+1))
	if err != nil || len(response) > hookInputLimit {
		return errors.New("broker response exceeds its bound")
	}
	var result toolExecution
	if json.Unmarshal(response, &result) != nil || result.Disposition == "" {
		return errors.New("broker response is malformed")
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func sendBrokerAction(action brokerRequest) (toolExecution, error) {
	request, _, err := loadRequest()
	if err != nil {
		return toolExecution{}, err
	}
	action.TaskFingerprint = request.TaskFingerprint
	action.AttemptID = request.AttemptID
	action.CapabilityToken = os.Getenv("EXEC_ACTION_CAPABILITY")
	encoded, err := json.Marshal(action)
	if err != nil {
		return toolExecution{}, err
	}
	connection, err := net.DialTimeout("unix", brokerSocket, 2*time.Second)
	if err != nil {
		return toolExecution{}, errors.New("Sandiva action broker is unavailable")
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := connection.Write(encoded); err != nil {
		return toolExecution{}, err
	}
	if unix, ok := connection.(*net.UnixConn); ok {
		_ = unix.CloseWrite()
	}
	response, err := io.ReadAll(io.LimitReader(connection, hookInputLimit+1))
	if err != nil || len(response) > hookInputLimit {
		return toolExecution{}, errors.New("broker response exceeds its bound")
	}
	var result toolExecution
	if json.Unmarshal(response, &result) != nil || result.Disposition == "" {
		return toolExecution{}, errors.New("broker response is malformed")
	}
	return result, nil
}

func serveMCP() error {
	sequence := 1
	scanner := bufio.NewScanner(io.LimitReader(os.Stdin, outputLimit+1))
	scanner.Buffer(make([]byte, 64*1024), hookInputLimit)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var message struct {
			JSONRPC string                 `json:"jsonrpc"`
			ID      interface{}            `json:"id"`
			Method  string                 `json:"method"`
			Params  map[string]interface{} `json:"params"`
		}
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&message) != nil || message.JSONRPC != "2.0" || message.Method == "" {
			return errors.New("MCP request is malformed")
		}
		if message.ID == nil {
			continue
		}
		response := map[string]interface{}{"jsonrpc": "2.0", "id": message.ID}
		switch message.Method {
		case "initialize":
			response["result"] = map[string]interface{}{"protocolVersion": "2024-11-05", "capabilities": map[string]interface{}{"tools": map[string]interface{}{}}, "serverInfo": map[string]interface{}{"name": "sandiva-execution-authority", "version": launcherVersion}}
		case "tools/list":
			response["result"] = map[string]interface{}{"tools": []interface{}{map[string]interface{}{"name": "sandiva_execute", "description": "Execute one task-bound repository action through Sandiva authority", "inputSchema": map[string]interface{}{"type": "object", "additionalProperties": false, "required": []string{"toolName", "toolInput"}, "properties": map[string]interface{}{"toolName": map[string]interface{}{"type": "string"}, "toolInput": map[string]interface{}{"type": "object"}}}}}}
		case "tools/call":
			name, _ := message.Params["name"].(string)
			arguments, _ := message.Params["arguments"].(map[string]interface{})
			toolName, _ := arguments["toolName"].(string)
			toolInput, _ := arguments["toolInput"].(map[string]interface{})
			if name != "sandiva_execute" || toolName == "" || toolInput == nil {
				response["error"] = map[string]interface{}{"code": -32602, "message": "action request is malformed"}
				break
			}
			result, actionErr := sendBrokerAction(brokerRequest{Sequence: sequence, ToolName: toolName, ToolInput: toolInput})
			sequence++
			if actionErr != nil {
				response["error"] = map[string]interface{}{"code": -32603, "message": "Sandiva action authority failed closed"}
				break
			}
			encoded, _ := json.Marshal(result)
			response["result"] = map[string]interface{}{"content": []interface{}{map[string]interface{}{"type": "text", "text": string(encoded)}}, "isError": result.Disposition != "authorized_and_executed"}
		default:
			response["error"] = map[string]interface{}{"code": -32601, "message": "method is not supported"}
		}
		if err := encoder.Encode(response); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func emitHookDecision(provider string, decision hookDecision) error {
	if provider != "codex" && provider != "claude" {
		return errors.New("hook provider is not allowlisted")
	}
	permission := "deny"
	var markerErr error
	if decision.Allowed {
		permission = "allow"
	} else {
		denial, err := json.Marshal(map[string]interface{}{
			"classification": "POLICY_DENIED", "phase": "PRE_TOOL_USE",
			"executed": false, "reason": decision.Reason,
		})
		if err != nil {
			return errors.New("pre-tool denial could not be encoded")
		}
		markerErr = os.WriteFile(denialMarker, append(denial, '\n'), 0600)
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]interface{}{
		"hookSpecificOutput": map[string]interface{}{
			"hookEventName": "PreToolUse", "permissionDecision": permission,
			"permissionDecisionReason": decision.Reason,
		},
	}); err != nil {
		return err
	}
	if markerErr != nil {
		return errors.New("pre-tool denial could not be durably recorded")
	}
	return nil
}

func authorize(provider string) error {
	if err := os.MkdirAll(filepath.Dir(denialMarker), 0700); err != nil {
		return errors.New("pre-tool authorization state cannot be initialized")
	}
	request, _, err := loadRequest()
	if err != nil {
		return emitHookDecision(provider, hookDecision{Reason: "sealed request could not be trusted"})
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, hookInputLimit+1))
	if err != nil || len(raw) > hookInputLimit {
		return emitHookDecision(provider, hookDecision{Reason: "pre-tool authorization input exceeds its bound"})
	}
	decision, err := authorizeTool(raw, request)
	if err != nil {
		return emitHookDecision(provider, hookDecision{Reason: "pre-tool authorizer failed closed"})
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
	for _, target := range []string{denialMarker, brokerSocket, brokerLedger, brokerReady} {
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return errors.New("execution authority state cannot be initialized")
		}
	}
	if err := os.MkdirAll("/run/exec/provider", 0700); err != nil {
		return err
	}
	if err := os.MkdirAll("/run/exec/authority", 0700); err != nil {
		return err
	}
	capabilityBytes := make([]byte, 32)
	if _, err := rand.Read(capabilityBytes); err != nil {
		return errors.New("action capability could not be created")
	}
	capability := hex.EncodeToString(capabilityBytes)
	broker := exec.Command(runtimeExecutablePath, "broker-serve")
	broker.Env = append(os.Environ(), "EXEC_ACTION_CAPABILITY="+capability)
	if err := broker.Start(); err != nil {
		return errors.New("Sandiva action broker could not start")
	}
	defer func() {
		if broker.Process != nil {
			_ = broker.Process.Kill()
		}
		_ = broker.Wait()
	}()
	ready := false
	for index := 0; index < 100; index++ {
		if _, err := os.Stat(brokerReady); err == nil {
			ready = true
			break
		}
		if broker.ProcessState != nil && broker.ProcessState.Exited() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !ready {
		return errors.New("Sandiva action broker did not attest readiness")
	}
	if err := os.WriteFile(denialMarker, nil, 0600); err != nil {
		return errors.New("pre-tool denial state cannot be created")
	}
	if err := os.Truncate(denialMarker, 0); err != nil {
		return err
	}
	if err := restrictProviderFilesystem(launcher); err != nil {
		return fmt.Errorf("Sandiva provider confinement failed closed: %w", err)
	}
	command := exec.Command(launcher, args[1:]...)
	command.Dir = "/run/exec/provider"
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
		"EXEC_ACTION_CAPABILITY=" + capability,
		"EXEC_ACTION_BROKER=" + brokerSocket,
	}
	if args[0] == "codex" {
		command.Env = append(command.Env, "CODEX_HOME=/opt/sandiva/codex", "OPENAI_BASE_URL="+gateway+"/v1", "OPENAI_API_KEY="+session)
	} else {
		command.Env = append(
			command.Env, "CLAUDE_CONFIG_DIR=/opt/sandiva/claude",
			"ANTHROPIC_BASE_URL="+gateway, "ANTHROPIC_AUTH_TOKEN="+session, "ANTHROPIC_API_KEY=",
		)
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
	markerInfo, markerErr := os.Stat(denialMarker)
	if markerErr == nil && markerInfo.Size() > 0 {
		markerDigest, digestErr := fileDigest(denialMarker)
		if digestErr != nil {
			return errors.New("pre-tool denial provenance cannot be read")
		}
		denialReference := fmt.Sprintf(
			"audit://exec01/%s/%s/pretool-policy-denial/%s",
			request.TaskFingerprint, request.AttemptID, markerDigest,
		)
		if args[0] == "codex" {
			result.Status = "blocked"
			result.ErrorType = "policy_denied"
			result.LogRefs = append(result.LogRefs, denialReference)
		} else {
			result.StopReason = "blocked"
			result.ErrorTypeC = "policy_denied"
			result.EvidenceRefs = append(result.EvidenceRefs, denialReference)
		}
	} else if !errors.Is(markerErr, os.ErrNotExist) {
		return errors.New("pre-tool authorization state cannot be read")
	}
	ledgerRaw, ledgerErr := os.ReadFile(brokerLedger)
	if ledgerErr != nil && !errors.Is(ledgerErr, os.ErrNotExist) {
		return errors.New("action broker provenance cannot be read")
	}
	trustedCommands := []string{}
	trustedTests := []map[string]interface{}{}
	brokerEvents := 0
	for _, line := range bytes.Split(bytes.TrimSpace(ledgerRaw), []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var event toolExecution
		if json.Unmarshal(line, &event) != nil {
			return errors.New("action broker provenance is malformed")
		}
		brokerEvents++
		if event.Disposition == "denied_before_execution" {
			if args[0] == "codex" {
				result.Status, result.ErrorType = "blocked", "policy_denied"
			} else {
				result.StopReason, result.ErrorTypeC = "blocked", "policy_denied"
			}
		}
		if event.Disposition == "provider_runtime_failure" {
			if args[0] == "codex" {
				result.Status, result.ErrorType = "failed", "internal_error"
			} else {
				result.StopReason, result.ErrorTypeC = "error", "internal_error"
			}
		}
		if event.Executed && event.Command != "" {
			trustedCommands = append(trustedCommands, event.Command)
			status := "PASS"
			if event.ExitCode != 0 {
				status = "FAIL"
			}
			trustedTests = append(trustedTests, map[string]interface{}{"name": "approved command: " + event.Command, "status": status, "command": event.Command})
		}
	}
	if brokerEvents == 0 {
		if args[0] == "codex" {
			result.Status, result.ErrorType = "failed", "internal_error"
		} else {
			result.StopReason, result.ErrorTypeC = "error", "internal_error"
		}
	}
	brokerReference := fmt.Sprintf("audit://exec01/%s/%s/sandiva-action-broker/%x", request.TaskFingerprint, request.AttemptID, sha256.Sum256(ledgerRaw))
	if args[0] == "codex" {
		result.Commands, result.Tests = trustedCommands, trustedTests
		result.LogRefs = append(result.LogRefs, brokerReference)
	} else {
		result.CommandsC, result.TestsC = trustedCommands, trustedTests
		result.EvidenceRefs = append(result.EvidenceRefs, brokerReference)
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
	runtimeDigest, err := fileDigest(runtimeExecutablePath)
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
	case "broker-serve":
		err = serveBroker()
	case "broker-action":
		err = brokerAction()
	case "mcp-server":
		err = serveMCP()
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
