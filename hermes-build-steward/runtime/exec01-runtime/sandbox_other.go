//go:build !linux

package main

import "errors"
import "os/exec"

func configureActionProcess(_ *exec.Cmd) {}

func killActionProcessGroup(_ int) {}

func restrictProviderFilesystem(_ string) error {
	return errors.New("Sandiva provider filesystem confinement requires Linux Landlock")
}
