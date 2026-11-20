"""Use the shipped stdio client against an explicitly named isolated acceptance map."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time

def main():
    p=argparse.ArgumentParser()
    p.add_argument("phase",choices=["connect","read"])
    p.add_argument("helper",type=Path)
    p.add_argument("out",type=Path)
    p.add_argument("project")
    args=p.parse_args()
    target=os.environ['WM_SESSION']
    record=json.loads((Path.home()/'.local/share/workspace-map/sessions'/(target+'.json')).read_text())
    assert record['name'].startswith('acceptance-records ')
    endpoint=os.environ['WM_VERIFY_ENDPOINT']; run_id=os.environ.get('WM_VERIFY_RUN','offline-cpu-replay')
    proc=subprocess.Popen([sys.executable,'-u',str(args.helper),'--map',record['mapId']],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
    counter=0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout,selectors.EVENT_READ)
            def request(method,params):
                nonlocal counter
                counter+=1
                proc.stdin.write(json.dumps(dict(jsonrpc="2.0",id=counter,method=method,params=params))+'\n');proc.stdin.flush()
                while selector.select(40):
                    msg=json.loads(proc.stdout.readline())
                    if msg.get('id')==counter:return msg['result']
                raise TimeoutError(method)
            def tool(name,**kw):
                response=request('tools/call',dict(name='map_'+name,arguments=kw))
                if response.get('isError'):raise RuntimeError(response['content'][0]['text'])
                return json.loads(response['content'][0]['text'])
            request('initialize',{})
            for _ in range(50):
                if tool('connection')['state']=='connected':break
                time.sleep(.1)
            if args.phase=='connect':
                tool('registerProject',ref={'endpoint':endpoint,'path':args.project});return
            result={}
            rows=tool('workloadsPage')['items']
            ids=[w['runId'] for w in rows]
            assert ids.count(run_id)==1
            row=tool('workloadDetail',runId=run_id,observe=True)
            assert row['step']==2 and row['phase']=='评测'
            scientific=next(f for f in row['files'] if f['kind']=='model')
            ref=lambda f:{k:f[k] for k in ('endpoint','path')}
            step=tool('modelAnalysis',ref=ref(scientific),view='step',attempt=2)['step']
            assert len(step['microbatches'])==4
            timing=next(f for f in row['files'] if f['kind']=='profile')
            result['stages']=tool('runProfile',ref=ref(timing))['phaseTotals']
            result['runId']=row['runId'];result['step']=step['attempt']
            rec=tool('recordingControl',action='start')
            try:
                sample=tool('systemResources',endpoint='wsl-ubuntu',section='comparison')
                result['wsl']=sample.get('wslBudget')
                if not result['wsl']:raise ValueError('WSL budget absent')
                limit=time.monotonic()+30
                while time.monotonic()<limit:
                    page=tool('recordingRead',id=rec['id'],limit=1)
                    if page['items']:break
                    time.sleep(1)
                assert page['items']
            finally:tool('recordingControl',action='stop')
            assert rec['id'] in tool('recordingControl',action='list')['recordings']
            filename=args.project+'/'+run_id+'-samples.json'
            job=tool('artifactExport',source={'kind':'recording','id':rec['id']},format='json',target={'endpoint':endpoint,'path':filename})
            for _ in range(200):
                receipt=tool('job',id=job['id'])
                if receipt['state'] in ('completed','failed','cancelled'):break
                time.sleep(.15)
            assert receipt['state']=='completed',receipt.get('error')
            result['export']=receipt['result']
            assert result['export']['bytes']>0 and len(result['export']['sha256'])==64
            args.out.write_text(json.dumps(result,indent=2,ensure_ascii=False))
    finally:
        proc.stdin.close()
        try:proc.wait(timeout=4)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':main()
