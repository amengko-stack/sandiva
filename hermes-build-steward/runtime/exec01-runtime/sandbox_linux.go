//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

func configureActionProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

func killActionProcessGroup(pid int) {
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}

func actionProcessHasChild(pid int) bool {
	paths, _ := filepath.Glob("/proc/" + strconv.Itoa(pid) + "/task/*/children")
	for _, path := range paths {
		value, err := os.ReadFile(path)
		if err == nil && strings.TrimSpace(string(value)) != "" {
			return true
		}
	}
	return false
}

// Linux Landlock ABI. The provider process tree receives read-only runtime
// access plus a private scratch directory, but no access at all to /workspace.
// The broker is forked before this irreversible restriction and remains the
// sole process capable of touching the authoritative repository workspace.
const (
	landlockCreateRuleset   = 444
	landlockAddRule         = 445
	landlockRestrictSelf    = 446
	landlockRulePathBeneath = 1
	landlockCreateVersion   = 1
	prSetNoNewPrivs         = 38

	llExecute    = uint64(1 << 0)
	llWriteFile  = uint64(1 << 1)
	llReadFile   = uint64(1 << 2)
	llReadDir    = uint64(1 << 3)
	llRemoveDir  = uint64(1 << 4)
	llRemoveFile = uint64(1 << 5)
	llMakeChar   = uint64(1 << 6)
	llMakeDir    = uint64(1 << 7)
	llMakeReg    = uint64(1 << 8)
	llMakeSock   = uint64(1 << 9)
	llMakeFifo   = uint64(1 << 10)
	llMakeBlock  = uint64(1 << 11)
	llMakeSym    = uint64(1 << 12)
	llRefer      = uint64(1 << 13)
	llTruncate   = uint64(1 << 14)
)

type landlockRulesetAttr struct{ HandledAccessFS uint64 }
type landlockPathBeneathAttr struct {
	AllowedAccess uint64
	ParentFD      int32
	_             uint32
}

func rawSyscall(number uintptr, a1, a2, a3 uintptr) (uintptr, syscall.Errno) {
	value, _, errno := syscall.Syscall(number, a1, a2, a3)
	return value, errno
}

func landlockABI() (int, error) {
	value, errno := rawSyscall(landlockCreateRuleset, 0, 0, landlockCreateVersion)
	if errno != 0 || value < 1 {
		return 0, errors.New("Landlock ABI is unavailable")
	}
	return int(value), nil
}

func restrictProviderFilesystem(launcher string) error {
	abi, err := landlockABI()
	if err != nil {
		return err
	}
	handled := llExecute | llWriteFile | llReadFile | llReadDir | llRemoveDir | llRemoveFile | llMakeChar | llMakeDir | llMakeReg | llMakeSock | llMakeFifo | llMakeBlock | llMakeSym
	if abi >= 2 {
		handled |= llRefer
	}
	if abi >= 3 {
		handled |= llTruncate
	}
	attr := landlockRulesetAttr{HandledAccessFS: handled}
	fdValue, errno := rawSyscall(landlockCreateRuleset, uintptr(unsafe.Pointer(&attr)), unsafe.Sizeof(attr), 0)
	if errno != 0 {
		return errors.New("Landlock ruleset creation failed")
	}
	fd := int(fdValue)
	defer syscall.Close(fd)
	add := func(path string, access uint64) error {
		file, openErr := os.Open(path)
		if openErr != nil {
			return openErr
		}
		defer file.Close()
		rule := landlockPathBeneathAttr{AllowedAccess: access, ParentFD: int32(file.Fd())}
		_, addErrno := rawSyscall(landlockAddRule, uintptr(fd), landlockRulePathBeneath, uintptr(unsafe.Pointer(&rule)))
		if addErrno != 0 {
			return fmt.Errorf("Landlock path rule creation failed for %s: %s", path, addErrno)
		}
		return nil
	}
	readOnly := llReadFile | llReadDir
	for _, path := range []string{"/opt", "/usr", "/bin", "/lib", "/etc"} {
		if err := add(path, readOnly); err != nil {
			return err
		}
	}
	// Landlock rejects directory-only rights such as READ_DIR on a file. The
	// provider may use the null device for bounded stdio but receives no device
	// creation authority.
	if err := add("/dev/null", llReadFile|llWriteFile); err != nil {
		return err
	}
	for _, path := range []string{launcher, runtimeExecutablePath} {
		if err := add(path, llReadFile|llExecute); err != nil {
			return err
		}
	}
	scratchAccess := handled &^ llExecute &^ llMakeChar &^ llMakeBlock
	if err := add("/run/exec/provider", scratchAccess); err != nil {
		return err
	}
	// The wrapper and provider-side MCP process must be able to traverse and
	// inspect the immutable authority artifacts after confinement. Directory
	// access is read-only; the specific denial marker below is the sole writable
	// child and the broker ledger remains non-writable.
	if err := add("/run/exec/authority", readOnly); err != nil {
		return err
	}
	for _, path := range []string{brokerLedger, brokerReady} {
		if err := add(path, llReadFile); err != nil {
			return err
		}
	}
	if err := add(denialMarker, llReadFile|llWriteFile|llTruncate); err != nil {
		return err
	}
	if _, _, errno = syscall.Syscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); errno != 0 {
		return errors.New("no-new-privileges could not be established")
	}
	if _, errno = rawSyscall(landlockRestrictSelf, uintptr(fd), 0, 0); errno != 0 {
		return errors.New("Landlock restriction could not be established")
	}
	return nil
}
