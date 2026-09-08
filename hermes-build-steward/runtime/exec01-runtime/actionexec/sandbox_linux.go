//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"unsafe"
)

const (
	landlockCreateRuleset   = 444
	landlockAddRule         = 445
	landlockRestrictSelf    = 446
	landlockRulePathBeneath = 1
	landlockCreateVersion   = 1
	prSetNoNewPrivs         = 38
	prSetSeccomp            = 22
	seccompModeFilter       = 2

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

	bpfLD   = uint16(0x00)
	bpfW    = uint16(0x00)
	bpfABS  = uint16(0x20)
	bpfJMP  = uint16(0x05)
	bpfJEQ  = uint16(0x10)
	bpfJSET = uint16(0x40)
	bpfK    = uint16(0x00)
	bpfRET  = uint16(0x06)

	seccompRetKillProcess = uint32(0x80000000)
	seccompRetErrno       = uint32(0x00050000)
	seccompRetAllow       = uint32(0x7fff0000)
)

type landlockRulesetAttr struct{ HandledAccessFS uint64 }
type landlockPathBeneathAttr struct {
	AllowedAccess uint64
	ParentFD      int32
	_             uint32
}
type sockFilter struct {
	Code uint16
	Jt   uint8
	Jf   uint8
	K    uint32
}
type sockFprog struct {
	Len    uint16
	Filter *sockFilter
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

func restrictActionFilesystem(scratch string) error {
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
		return errors.New("action Landlock ruleset creation failed")
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
			return fmt.Errorf("action Landlock rule failed for %s: %s", path, addErrno)
		}
		return nil
	}
	readOnly := llReadFile | llReadDir
	readExecute := readOnly | llExecute
	for _, path := range []string{"/bin", "/usr", "/lib"} {
		if err := add(path, readExecute); err != nil {
			return err
		}
	}
	for _, path := range []string{"/etc", "/opt"} {
		if err := add(path, readOnly); err != nil {
			return err
		}
	}
	for _, path := range []string{"/dev/null", "/dev/urandom", "/dev/random"} {
		if err := add(path, llReadFile|llWriteFile); err != nil {
			return err
		}
	}
	writable := handled &^ llExecute &^ llMakeChar &^ llMakeBlock
	for _, path := range []string{workspace, scratch, "/tmp"} {
		if err := add(path, writable); err != nil {
			return err
		}
	}
	if _, _, errno = syscall.Syscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); errno != 0 {
		return errors.New("action no-new-privileges could not be established")
	}
	if _, errno = rawSyscall(landlockRestrictSelf, uintptr(fd), 0, 0); errno != 0 {
		return errors.New("action Landlock restriction could not be established")
	}
	return nil
}

func seccompIdentity() (uint32, []uint32, error) {
	switch runtime.GOARCH {
	case "amd64":
		return 0xc000003e, []uint32{
			41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
			62, 101, 109, 112, 129, 141, 142, 144, 200, 203, 234, 288, 297,
			299, 307, 310, 311, 312, 424, 438,
		}, nil
	case "arm64":
		return 0xc00000b7, []uint32{
			117, 118, 119, 122, 129, 130, 131, 138, 140, 154, 157, 198, 199,
			200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212,
			240, 242, 243, 269, 270, 271, 272, 424, 438,
		}, nil
	default:
		return 0, nil, errors.New("action seccomp architecture is unsupported")
	}
}

func restrictActionSyscalls() error {
	architecture, denied, err := seccompIdentity()
	if err != nil {
		return err
	}
	filters := []sockFilter{
		{Code: bpfLD | bpfW | bpfABS, K: 4},
		{Code: bpfJMP | bpfJEQ | bpfK, Jt: 1, Jf: 0, K: architecture},
		{Code: bpfRET | bpfK, K: seccompRetKillProcess},
		{Code: bpfLD | bpfW | bpfABS, K: 0},
	}
	if runtime.GOARCH == "amd64" {
		// x32 shares the x86-64 audit architecture with a high syscall bit.
		// Deny that alternate ABI so it cannot bypass the closed syscall list.
		filters = append(filters,
			sockFilter{Code: bpfJMP | bpfJSET | bpfK, Jt: 0, Jf: 1, K: 0x40000000},
			sockFilter{Code: bpfRET | bpfK, K: seccompRetErrno | uint32(syscall.EPERM)},
		)
	}
	for _, number := range denied {
		filters = append(filters,
			sockFilter{Code: bpfJMP | bpfJEQ | bpfK, Jt: 0, Jf: 1, K: number},
			sockFilter{Code: bpfRET | bpfK, K: seccompRetErrno | uint32(syscall.EPERM)},
		)
	}
	filters = append(filters, sockFilter{Code: bpfRET | bpfK, K: seccompRetAllow})
	program := sockFprog{Len: uint16(len(filters)), Filter: &filters[0]}
	if _, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, prSetSeccomp, seccompModeFilter, uintptr(unsafe.Pointer(&program)), 0, 0, 0); errno != 0 {
		return errors.New("action seccomp restriction could not be established")
	}
	return nil
}

func runSandboxedAction(mode string, arguments []string, scratch string) int {
	// Landlock and seccomp attach to the calling thread. Keep the entire
	// restriction and fork/exec sequence on one OS thread so the untrusted
	// command cannot inherit an unrestricted Go runtime thread.
	runtime.LockOSThread()
	status := os.NewFile(3, "action-status")
	if status == nil {
		return 125
	}
	defer status.Close()
	syscall.CloseOnExec(3)
	if err := restrictActionFilesystem(scratch); err != nil {
		fmt.Fprintln(os.Stderr, "action filesystem confinement failed")
		return 125
	}
	if err := restrictActionSyscalls(); err != nil {
		fmt.Fprintln(os.Stderr, "action syscall confinement failed")
		return 125
	}
	var command *exec.Cmd
	switch mode {
	case "shell":
		if len(arguments) != 1 {
			return 125
		}
		command = exec.Command("/bin/sh", "-c", arguments[0])
	case "patch":
		if len(arguments) == 0 {
			return 125
		}
		command = exec.Command("/usr/bin/patch", arguments...)
	default:
		return 125
	}
	command.Dir = workspace
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	command.Env = []string{
		"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + scratch, "TMPDIR=" + scratch,
		"CI=true", "LANG=C.UTF-8", "LC_ALL=C.UTF-8",
	}
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	if err := command.Start(); err != nil {
		return 125
	}
	if _, err := status.Write([]byte("executed\n")); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return 123
	}
	_ = status.Close()
	if err := command.Wait(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode()
		}
		return 125
	}
	return 0
}
