"""Switch the probe's scene in a running Claude Code and save the screen, plain and in colour.

usage: python3 docs/research/board-scenes/capture.py herdr <pane_id> <out_dir> <suffix> <scene> [<scene> ...]
       python3 docs/research/board-scenes/capture.py tmux <session> <out_dir> <suffix> <scene> [<scene> ...]
"""
import subprocess
import sys
import time

mode, target, out, suffix, *scenes = sys.argv[1:]

def run(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

for scene in scenes:
    if mode == 'herdr':
        run('herdr', 'pane', 'send-text', target, f'/dpscene {scene}')
        run('herdr', 'pane', 'send-keys', target, 'enter')
        time.sleep(3)
        plain = run('herdr', 'pane', 'read', target, '--source', 'visible')
        ansi = run('herdr', 'pane', 'read', target, '--source', 'visible', '--format', 'ansi')
    else:
        run('tmux', 'send-keys', '-t', target, f'/dpscene {scene}', 'Enter')
        time.sleep(3)
        plain = run('tmux', 'capture-pane', '-t', target, '-p')
        ansi = run('tmux', 'capture-pane', '-t', target, '-p', '-e')
    open(f'{out}/{mode}-{scene}-{suffix}.txt', 'w', encoding='utf-8').write(plain)
    open(f'{out}/{mode}-{scene}-{suffix}.ansi', 'w', encoding='utf-8').write(ansi)
    print(f'saved {mode}-{scene}-{suffix}')
