package main

// Workspace file browsing/editing and read-only git views, restricted to configured workspace roots.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxRead = 2 << 20

func resolveIn(c *Config, w string, rel string) (base, p string, ok bool) {
	idx, err := strconv.Atoi(w)
	ws := c.WorkspacesCopy()
	if err != nil || idx < 0 || idx >= len(ws) {
		return "", "", false
	}
	base, err = filepath.EvalSymlinks(ws[idx])
	if err != nil {
		return "", "", false
	}
	base, _ = filepath.Abs(base)
	rel = strings.TrimLeft(rel, `/\`)
	p, _ = filepath.Abs(filepath.Join(base, filepath.FromSlash(rel)))
	inside := func(x string) bool { return x == base || strings.HasPrefix(x, base+string(filepath.Separator)) }
	if !inside(p) {
		return "", "", false
	}
	if real, err := filepath.EvalSymlinks(p); err == nil && !inside(real) {
		return "", "", false
	}
	return base, p, true
}

func errCode(err error) string {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "ENOENT"
	case errors.Is(err, fs.ErrPermission):
		return "EACCES"
	}
	return err.Error()
}

type DirItem struct {
	Name  string  `json:"name"`
	Dir   bool    `json:"dir"`
	Size  int64   `json:"size"`
	Mtime float64 `json:"mtime"`
}

func fsList(c *Config, w, rel string) Result {
	base, p, ok := resolveIn(c, w, rel)
	if !ok {
		return failRes("outside workspace")
	}
	ents, err := os.ReadDir(p)
	if err != nil {
		return failRes(errCode(err))
	}
	items := []DirItem{}
	for _, e := range ents {
		it := DirItem{Name: e.Name(), Dir: e.IsDir()}
		if st, err := os.Stat(filepath.Join(p, e.Name())); err == nil {
			it.Dir, it.Size, it.Mtime = st.IsDir(), st.Size(), mtimeMs(st)
		}
		items = append(items, it)
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Dir != items[j].Dir {
			return items[i].Dir
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	r, _ := filepath.Rel(base, p)
	if r == "." {
		r = ""
	}
	return Result{"ok": true, "rel": filepath.ToSlash(r), "items": items}
}

func fsRead(c *Config, w, rel string) Result {
	_, p, ok := resolveIn(c, w, rel)
	if !ok {
		return failRes("outside workspace")
	}
	st, err := os.Stat(p)
	if err != nil {
		return failRes(errCode(err))
	}
	if !st.Mode().IsRegular() {
		return failRes("not a file")
	}
	if st.Size() > maxRead {
		return failRes(fmt.Sprintf("file is %d bytes, limit %d", st.Size(), maxRead))
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return failRes(errCode(err))
	}
	head := b
	if len(head) > 8000 {
		head = head[:8000]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return Result{"ok": false, "reason": "binary file", "binary": true, "size": st.Size()}
	}
	return Result{"ok": true, "content": string(b), "mtime": mtimeMs(st), "size": st.Size()}
}

func fsWrite(c *Config, w, rel, content string, baseMtime *float64) Result {
	_, p, ok := resolveIn(c, w, rel)
	if !ok {
		return failRes("outside workspace")
	}
	if st, err := os.Stat(p); err == nil && baseMtime != nil && math.Abs(mtimeMs(st)-*baseMtime) > 1 {
		return Result{"ok": false, "conflict": true, "reason": "file changed on the laptop since you opened it (maybe the agent edited it). Reload before saving."}
	}
	mode := fs.FileMode(0o644)
	if st, err := os.Stat(p); err == nil {
		mode = st.Mode().Perm()
	}
	tmp := p + ".agrc-tmp"
	if err := os.WriteFile(tmp, []byte(content), mode); err != nil {
		return failRes(errCode(err))
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		return failRes(errCode(err))
	}
	st, _ := os.Stat(p)
	return Result{"ok": true, "mtime": mtimeMs(st)}
}

type limitBuf struct {
	b         bytes.Buffer
	max       int
	truncated bool
}

func (l *limitBuf) Write(p []byte) (int, error) {
	room := l.max - l.b.Len()
	if room <= 0 {
		l.truncated = true
		return len(p), nil
	}
	if len(p) > room {
		l.b.Write(p[:room])
		l.truncated = true
		return len(p), nil
	}
	return l.b.Write(p)
}

func git(dir string, max int, args ...string) (string, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	hideWindow(cmd)
	out := &limitBuf{max: max}
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = out, &stderr
	err := cmd.Run()
	if err != nil && out.b.Len() == 0 {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", false, errors.New(truncBytes(msg, 500))
	}
	return out.b.String(), out.truncated, nil
}

type GitFile struct {
	X    string `json:"x"`
	Y    string `json:"y"`
	Path string `json:"path"`
}

func gitStatus(c *Config, w string) Result {
	base, _, ok := resolveIn(c, w, "")
	if !ok {
		return failRes("no workspace")
	}
	out, _, err := git(base, 4<<20, "status", "--porcelain=v1", "-b", "--untracked-files=all")
	if err != nil {
		return failRes(err.Error())
	}
	lines := []string{}
	for _, l := range strings.Split(out, "\n") {
		if l != "" {
			lines = append(lines, l)
		}
	}
	branch := ""
	if len(lines) > 0 && strings.HasPrefix(lines[0], "## ") {
		branch = lines[0][3:]
		lines = lines[1:]
	}
	files := []GitFile{}
	for _, l := range lines {
		if len(l) < 4 {
			continue
		}
		path := l[3:]
		if uq, err := strconv.Unquote(path); err == nil && strings.HasPrefix(path, `"`) {
			path = uq
		}
		files = append(files, GitFile{X: l[0:1], Y: l[1:2], Path: path})
	}
	stat, _, _ := git(base, 1<<20, "diff", "--stat", "HEAD")
	return Result{"ok": true, "branch": branch, "files": files, "stat": stat}
}

func gitDiff(c *Config, w, rel string) Result {
	base, _, ok := resolveIn(c, w, "")
	if !ok {
		return failRes("no workspace")
	}
	args := []string{"diff", "HEAD", "--no-color", "--no-ext-diff"}
	if rel != "" {
		_, p, ok := resolveIn(c, w, rel)
		if !ok {
			return failRes("outside workspace")
		}
		r, _ := filepath.Rel(base, p)
		args = append(args, "--", filepath.ToSlash(r))
	}
	out, trunc, err := git(base, 3<<20, args...)
	if err != nil {
		return failRes(err.Error())
	}
	if out == "" && rel != "" {
		if rf := fsRead(c, w, rel); rf["ok"] == true {
			lines := strings.Split(rf["content"].(string), "\n")
			for i := range lines {
				lines[i] = "+" + lines[i]
			}
			return Result{"ok": true, "out": "+++ " + rel + " (untracked)\n" + strings.Join(lines, "\n")}
		}
	}
	return Result{"ok": true, "out": out, "truncated": trunc}
}
