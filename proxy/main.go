// opencode-acp-proxy wraps `opencode acp` to sanitize malformed file:// URIs
// sent by ACP clients on Windows (e.g. file:///C%3A%5Cpath%5Cto%5Cfile).
// opencode's resolveUserPart calls fileURLToPath, which throws
// ERR_INVALID_FILE_URL_PATH on URIs containing %5C/%2F, breaking prompts
// that carry file context. This proxy rewrites such URIs on the inbound
// (client -> agent) stream only.
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

	real := os.Getenv("OPENCODE_REAL")
	if real == "" {
		for _, c := range []string{
			filepath.Join(dir, "node_modules", "opencode-ai", "bin", "opencode.exe"),
			filepath.Join(dir, "opencode-real.exe"),
		} {
			if _, err := os.Stat(c); err == nil {
				real = c
				break
			}
		}
	}
	if real == "" {
		fmt.Fprintln(os.Stderr, "proxy: real opencode.exe not found; set OPENCODE_REAL")
		os.Exit(1)
	}

	cmd := exec.Command(real, os.Args[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "proxy: stdin pipe: %v\n", err)
		os.Exit(1)
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "proxy: start %s: %v\n", real, err)
		os.Exit(1)
	}

	var logf *os.File
	if p := os.Getenv("OPENCODE_PROXY_LOG"); p != "" {
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
