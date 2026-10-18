// codebuddy-acp-proxy wraps `codebuddy --acp` to sanitize malformed file://
// URIs sent by ACP clients on Windows (e.g. file:///C%3A%5Cpath%5Cto%5Cfile).
// CodeBuddy reduces such URIs to their basename, so a resource_link pointing
// at file:///C%3A%5Cdir%5Cfile.txt makes the model Read "file.txt" relative to
// the cwd and fail with "File does not exist." This proxy rewrites %5C/%2F/%3A
// on the inbound (client -> agent) stream only.
package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var fileURI = regexp.MustCompile(`file://[^\s"'<>]+`)

var dec = strings.NewReplacer(
	"%5C", "/", "%5c", "/",
	"%2F", "/", "%2f", "/",
	"%3A", ":", "%3a", ":",
)

func sanitize(line string) string {
	return fileURI.ReplaceAllStringFunc(line, func(u string) string {
		return dec.Replace(u)
	})
}

func main() {
	self, _ := os.Executable()
	dir := filepath.Dir(self)

	node := os.Getenv("CODEBUDDY_NODE")
	if node == "" {
		node = "node.exe"
	}

	entry := os.Getenv("CODEBUDDY_ENTRY")
	if entry == "" {
		for _, c := range []string{
			filepath.Join(dir, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy"),
			filepath.Join(dir, "..", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy"),
		} {
			if _, err := os.Stat(c); err == nil {
				entry = c
				break
			}
		}
	}
	if entry == "" {
		fmt.Fprintln(os.Stderr, "proxy: codebuddy entry not found; set CODEBUDDY_ENTRY to <pkg>/bin/codebuddy")
		os.Exit(1)
	}

	args := append([]string{entry}, os.Args[1:]...)
	cmd := exec.Command(node, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "proxy: stdin pipe: %v\n", err)
		os.Exit(1)
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "proxy: start %s %s: %v\n", node, entry, err)
		os.Exit(1)
	}

	var logf *os.File
	if p := os.Getenv("CODEBUDDY_PROXY_LOG"); p != "" {
		if f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); err == nil {
			logf = f
			defer logf.Close()
		}
	}

	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 1<<20), 64<<20)
		w := bufio.NewWriter(stdin)
		for sc.Scan() {
			line := sc.Text()
			if logf != nil {
				fmt.Fprintf(logf, "%s\n", line)
			}
			w.WriteString(sanitize(line))
			w.WriteByte('\n')
			w.Flush()
		}
		stdin.Close()
	}()

	if err := cmd.Wait(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		os.Exit(1)
	}
}
