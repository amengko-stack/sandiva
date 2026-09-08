//go:build !linux

package main

func runSandboxedAction(_ string, _ []string, _ string) int { return 125 }
