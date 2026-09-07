//go:build !linux

package main

import "errors"

func restrictProviderFilesystem(_ string) error {
	return errors.New("Sandiva provider filesystem confinement requires Linux Landlock")
}
