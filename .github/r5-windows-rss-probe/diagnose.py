"""Separate helper transport and process ownership failures during descendant churn."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve()
DIR = Path(".context/rss-probe")

def worker():
    churn = threading.Event()
    done = threading.Event()
    def spawn_children():
        while not done.is_set():
            if churn.wait(0.05) and not done.is_set():
                subprocess.run([sys.executable, "-c", "import time; time.sleep(.07)"], check=True, timeout=3)
    churn_thread = threading.Thread(target=spawn_children)
    churn_thread.start()
    try:
        for cmd in sys.stdin:
            if cmd.strip() == "stop":
                break
            if cmd.strip() == "churn":
                churn.set()
    finally:
        done.set()
        churn_thread.join()

def main():
    DIR.mkdir(parents=True, exist_ok=True)
    stock = Path("scripts/windows-process-tree-sampler.ps1").read_text()
    catch = "    # Bounded categories only:"
    assert stock.count(catch) == 1
    extra = """
    $category = 'exception'
    foreach ($known in @('identity-race','parent-identity-race','root-identity-changed','creation-time-unavailable','duplicate-process','cyclic-process-tree','tree-limit')) {
      if ($_.Exception.Message -eq $known) { $category = $known }
    }
    $site = $_.InvocationInfo.ScriptLineNumber
    $kind = $_.Exception.GetBaseException().GetType().Name
    $role = if ($rootId -eq $entryId) { 'root' } else { 'descendant' }
    $failure = "$failure/$role/$site/$kind/$category"
"""
    script = DIR / "helper.ps1"
    script.write_bytes(stock.replace(catch, extra + catch).encode())
    helper = subprocess.Popen(["powershell.exe","-NoLogo","-NoProfile","-NonInteractive","-File",str(script.resolve())],
                              stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,encoding="utf-8")
    root = subprocess.Popen([sys.executable,"-u",str(HERE),"worker"], stdin=subprocess.PIPE,text=True)
    responses = queue.Queue()
    def read():
        for line in helper.stdout:
            responses.put(json.loads(line))
    threading.Thread(target=read,daemon=True).start()
    evidence = {}
    try:
        ready = responses.get(timeout=10)
        assert (ready["kind"],ready["processId"]) == ("ready",helper.pid)
        identity = None
        seq = 0
        for mode,n in [("stable",25),("churn",75)]:
            if mode == "churn":
                root.stdin.write("churn\n")
                root.stdin.flush()
                time.sleep(.1)
            counts, durations, sizes = Counter(), [], []
            for _ in range(n):
                seq += 1
                request = {"protocol":1,"id":str(seq),"rootProcessId":root.pid,"expectedRootIdentity":identity}
                start=time.perf_counter()
                helper.stdin.write(json.dumps(request)+"\n")
                helper.stdin.flush()
                rep=responses.get(timeout=1)
                durations.append(round(1000*(time.perf_counter()-start),1))
                assert rep["id"]==str(seq) and rep["kind"]=="sample"
                if rep["ok"]:
                    rows=rep["entries"]
                    frame=next(r for r in rows if r["processId"]==root.pid)
                    if identity: assert frame["startIdentity"]==identity
                    identity=frame["startIdentity"]
                    sizes.append(len(rows))
                    counts["success"]+=1
                else:
                    counts[rep["reason"]]+=1
                time.sleep(.25)
            evidence[mode]={"attempts":n,"results":counts,"maximumReplyMs":max(durations),"observedTreeSizes":dict(Counter(sizes))}
    finally:
        helper.stdin.close()
        root.stdin.write("stop\n")
        root.stdin.close()
        for owned in [root,helper]:
            try: owned.wait(timeout=3)
            except subprocess.TimeoutExpired:
                owned.kill()
                owned.wait(timeout=3)
        (DIR/"result.json").write_text(json.dumps(evidence,indent=2)+"\n")
        print(json.dumps(evidence))
if __name__=="__main__":
    if sys.argv[1:] == ["worker"]: worker()
    else: main()
