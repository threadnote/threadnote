#!/usr/bin/env python3
"""Synthetic stores only: exact admission, retained history and locked workflow recovery."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from product_skills_fixture import configure_product_skills, assert_product_provenance
PRODUCT_SKILLS = configure_product_skills(__file__, 6)
# Match the dev-plan entrypoint's sibling import resolution, including its own transport.
sys.path.insert(0, str(PRODUCT_SKILLS / "dev-plan/scripts"))

import copy
import json
import random
import tempfile
import unittest
import dev_plan as dp
import closeout as co
import workflow_transport as wt

assert_product_provenance(PRODUCT_SKILLS, "closeout-imports")

def fixture(directory):
    p=Path(directory);(p/'source.py').write_text('value = 1\n')
    scope=dp.inspect(p,['source.py'])
    context={'contextRefs':[],'contextNote':'Synthetic no-context fixture.','codeRefs':['source.py']}
    phase={**context,'id':'deliver','title':'Deliver','outcome':'Implemented','dependsOn':[], 'affectedPaths':['source.py'],'newPaths':[],'contracts':['Preserve history'],'acceptance':[{'id':'A1','criterion':'Done','verification':'synthetic verification','requirements':['R1']}],'safeBoundary':'Single complete change'}
    plan={'schemaVersion':1,'id':'synthetic-plan','project':'synthetic','title':'Synthetic','objective':'Exercise closeout capacity','scope':scope,**context,'requirements':[{'id':'R1','behavior':'Preserve history'}],'recall':{'queries':['synthetic'],'sources':[]},'phases':[phase],'current':{**context,'summary':'Current','diagram':'flowchart LR\n A-->B','invariants':[],'unknowns':[]},'target':{**context,'summary':'Target','diagram':'flowchart LR\n A-->B','contracts':['Preserve history'],'decisions':[]},'openQuestions':[],'review':{'required':False,'reason':'Synthetic fixture'}}
    prefix='threadnote://user/synthetic/memories/durable/projects/synthetic/'
    root_uri=prefix+'root-'+('r'*85)+'.md'
    children={k:prefix+k+'-'+('c'*85)+'.md' for k in ('current','target')}
    prior={prefix+f'prior-{i:03}-'+('p'*85)+'.md':'unused-history-pin' for i in range(124)}
    root=dp.record_for(plan,'root',{**{k:v for k,v in plan.items() if k not in ('current','target','phases')},'readiness':'ready','children':children,'singlePhase':phase,'phaseSummary':[phase],'priorArtifacts':prior},'Synthetic root')
    root['runId']='synthetic-run'
    records={root_uri:root}
    for k,uri in children.items():records[uri]={**dp.record_for(plan,k,plan[k],k),'runId':'synthetic-run'}
    for uri in prior:records[uri]={**dp.record_for(plan,'phase',phase,'Historical synthetic phase'),'runId':'synthetic-run'}
    implemented={**context,'summary':'Implemented','diagram':'flowchart LR\n A-->B','invariants':[],'unknowns':[],'contracts':['Preserve history'],'deviations':[],'scope':scope,'recallSources':[]}
    evidence={'rootHash':dp.digest(root),'scopeHash':dp.digest(scope),'architectureVerification':'Synthetic source fixture verified','phases':[{'id':'deliver','status':'complete','acceptance':[{'id':'A1','evidence':'Synthetic acceptance passed'}]}]}
    return root_uri,implemented,evidence,{uri:dp.memory_text(record) for uri,record in records.items()}


class Protocol:
    def __init__(self,bodies):
        self.bodies=copy.deepcopy(bodies);self.states={k:'active' for k in bodies}
        self.mutations=[];self.readonly=[];self.results={};self.fail_after_archive=False
        self.drift_preflight=False;self.corrupt_save=False;self.change_source=False
        self.planned={};self.on_mutation=None
    def read(self,uri):
        if uri not in self.bodies:return {'protocolVersion':1,'status':'not-found','requestedUri':uri}
        body=self.bodies[uri];record=dp.load_record(body)
        return {'protocolVersion':1,'status':'ok','verifiedReadback':True,'canonicalUri':uri,'state':self.states[uri],
                'body':body,'bodySha256':wt.body_hash(body),'revision':wt.body_hash('NATIVE\n'+body),
                'storageKind':record['memoryKind'],'sourceRunId':record['runId'],'artifactKey':uri.rsplit('/',1)[-1].removesuffix('.md'),'role':record['kind']}
    def destination(self,r):
        if r.get('mutation',r['action'])=='archive':
            kind='durable' if self.read(r['uri'])['storageKind']=='durable' else 'handoffs'
            return f'threadnote://user/synthetic/memories/{kind}/archived/synthetic/binding-archive-{r["operationId"]}.md'
        if r.get('artifactKey')=='independent-other':return 'threadnote://user/synthetic/memories/durable/projects/synthetic/independent-other.md'
        return r.get('uri') or 'threadnote://user/synthetic/memories/durable/projects/synthetic/implemented.md'
    def __call__(self,r):
        a=r['action']
        if a=='read':self.readonly.append(a);return self.read(r['uri'])
        if a=='recover':
            if r['operationId'] in self.results:return self.results[r['operationId']]
            return {'protocolVersion':1,'status':'error','code':'operation-not-found','message':'Not executed'}
        if a=='preflight':
            self.readonly.append(a)
            dest=self.destination(r)
            if r['mutation']=='archive':
                src=self.read(r['uri']);assert src['revision']==r['expectedRevision']
                if self.drift_preflight and r['operationId'] in self.planned:dest += '.changed'
                self.planned[r['operationId']]=dest
                sha=src['bodySha256']
            else:sha=r['bodySha256']
            return {'protocolVersion':1,'status':'ok','canonicalUri':dest,'beforeRevision':r.get('expectedRevision'),
                    'bodySha256':sha,'storageKind':'durable','role':r['role']}
        if r['operationId'] in self.results:return self.results[r['operationId']]
        dest=self.destination(r)
        if a=='archive':
            src=self.read(r['uri']);assert src['revision']==r['expectedRevision']
            self.bodies[dest]=self.bodies.pop(r['uri']);self.states.pop(r['uri']);self.states[dest]='archived'
        else:
            self.bodies[dest]=r['body'];self.states[dest]='active'
            if self.corrupt_save:self.bodies[dest]=self.bodies[dest].replace('# Synthetic','# Changed',1)
        self.mutations.append((a,dest))
        if self.on_mutation:self.on_mutation(a,dest)
        if self.change_source and a=='create':
            src=next(k for k in self.bodies if '/current-' in k and '/archived/' not in k)
            rec=dp.load_record(self.bodies[src]);rec['title']+=' changed';self.bodies[src]=dp.memory_text(rec)
        result={**self.read(dest),'operationId':r['operationId']};self.results[r['operationId']]=result
        if a=='archive' and self.fail_after_archive:
            self.fail_after_archive=False
            raise OSError('Synthetic interruption after archive committed, before response')
        return result

def setup(tmp, count=127):
    root,imp,ev,bodies=fixture(tmp)
    if count<127:
        record=dp.load_record(bodies[root]);old_keys=list(record['data']['priorArtifacts'])
        for k in old_keys[count-3:]:record['data']['priorArtifacts'].pop(k);bodies.pop(k)
        bodies[root]=dp.memory_text(record);ev['rootHash']=dp.digest(record)
    # Genuine mixed record/native storage kinds are retained by the protocol double.
    for k in list(bodies)[-min(14,len(bodies)-1):]:
        r=dp.load_record(bodies[k]);r['memoryKind']='handoff';bodies[k]=dp.memory_text(r)
    protocol=Protocol(bodies)
    context=Path(tmp)/'context.json'
    binding={'bindingId':'binding','generation':wt.generation(),'repo':str(Path(tmp).resolve()),'home':str(Path(tmp).resolve()),'profile':'desktop','project':'synthetic','featureId':'synthetic-plan'}
    wt.save_json(context,{'protocolVersion':1,'binding':binding,'operations':{}})
    transport=wt.WorkflowTransport(context,tmp,tmp,invoke=protocol)
    client=object.__new__(dp.Threadnote);client.repo=tmp;client.home=tmp;client.workflow=transport;client.workflow_options={};client.archive_runtime_policy=None
    return root,imp,ev,bodies,protocol,client,Path(tmp)/'receipt.json'

class Tests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(assert_product_provenance, PRODUCT_SKILLS, self.id())

    def test_legacy_renderer_roundtrip_and_nonmutation(self):
        record = {'schemaVersion': 1, 'title': 'Legacy -- 漢', 'kind': 'implemented', 'data': {'summary': 'Stable', 'diagram': 'flowchart LR\n A-->B', 'invariants': [], 'unknowns': [], 'archiveMap': {'source--漢': 'destination--🙂'}, 'supersededArchitecture': {'current': 'uri--x'}}}
        expected = '# Legacy -- 漢\n\nStable\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n**Superseded architecture**\n\n- [current](uri--x)\n\n**Archived planning history**\n\n- [source--漢](destination--🙂)\n\n<!-- dev-plan:v1 {"data":{"archiveMap":{"source\\u002d\\u002d漢":"destination\\u002d\\u002d🙂"},"diagram":"flowchart LR\\n A\\u002d\\u002d>B","invariants":[],"summary":"Stable","supersededArchitecture":{"current":"uri\\u002d\\u002dx"},"unknowns":[]},"kind":"implemented","schemaVersion":1,"title":"Legacy \\u002d\\u002d 漢"} -->\n'
        before = copy.deepcopy(record)
        self.assertEqual(dp.memory_text(record), expected)
        self.assertEqual(dp.load_record(expected), record)
        self.assertEqual(record, before)

    def test_summary_full_map_unicode_escaping_property(self):
        randomizer=random.Random(9216)
        for i in range(30):
            mapping={f'threadnote://user/u/memories/source--漢{k}':f'threadnote://user/u/memories/archive--🙂{randomizer.randrange(100000)}' for k in range(i*5)}
            r={'schemaVersion':1,'title':'test','kind':'implemented','data':{'summary':'漢🙂--','diagram':'flowchart LR\n A-->B','invariants':[],'unknowns':[],'archiveMap':mapping,'archiveMapPresentation':'summary-v1'}}
            before=copy.deepcopy(r);body=dp.memory_text(r)
            self.assertEqual(dp.load_record(body),r);self.assertEqual(r,before)
            human=body.split(dp.MARKER)[0]
            self.assertNotIn('threadnote://',human)
            self.assertEqual(dp.load_record(body)['data']['archiveMap'],mapping)
            self.assertEqual(body.count(dp.MARKER),1)
            self.assertNotIn('--',body[body.index(dp.MARKER)+len(dp.MARKER):-len(' -->\n')])
    def test_unknown_presentation_refused(self):
        r={'title':'test','kind':'implemented','data':{'summary':'x','diagram':'flowchart LR\n A-->B','invariants':[],'unknowns':[],'archiveMapPresentation':'future'}}
        with self.assertRaisesRegex(dp.PlanError,'Unsupported'):dp.memory_text(r)
    def test_127_archive_complete_order_and_exact_admission(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,bodies,p,c,state=setup(tmp)
            def on_write(a,d):
                saved=dp.read_json(state)
                self.assertLessEqual(saved['finalSizeAdmission']['finalBodyBytes'],60000)
                self.assertEqual(len(saved['archivePlans']),127)
                if a=='archive':self.assertEqual(p.mutations[0][0],'create')
            p.on_mutation=on_write
            result=co.complete(root,imp,ev,state,c)
            self.assertEqual(result['status'],'complete');self.assertEqual(len(result['archiveMap']),127)
            self.assertEqual([a for a,_ in p.mutations],['create']+['archive']*127+['replace'])
            final=dp.load_record(c.read(result['implementedUri']))
            self.assertEqual(final['data']['archiveMap'],result['archiveMap'])
            self.assertEqual(final['data']['planningRoot'],result['archiveMap'][root])
            self.assertEqual(final['relations'],[])
            self.assertEqual(sum('/handoffs/' in v for v in result['archiveMap'].values()),14)
            self.assertEqual(dp.digest(final),dp.read_json(state)['finalSizeAdmission']['finalRecordHash'])
            for source,archive in result['archiveMap'].items():self.assertEqual(c.read(archive),bodies[source])
            n=len(p.mutations);self.assertEqual(co.complete(root,imp,ev,state,c),result);self.assertEqual(len(p.mutations),n)
    def test_136_dynamic_history_with_recursive_index_and_duplicate_navigation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp)
            r=dp.load_record(b[root]);template=dp.load_record(b[next(k for k in b if '/prior-' in k)])
            prefix=root.rsplit('/',1)[0]+'/'
            new_uris=[]
            for i in range(8):
                uri=prefix+f'amendment-history-{i}.md'
                p.bodies[uri]=dp.memory_text(template);p.states[uri]='active';new_uris.append(uri)
            # Only the index is directly reachable; its8 members are reached recursively.
            index_uri=prefix+'amendment-index.md'
            index=dp.record_for({'id':r['planId'],'project':r['project']},'index',{'members':{str(i):u for i,u in enumerate(new_uris)}},'Amendment history')
            index['runId']=r['runId'];p.bodies[index_uri]=dp.memory_text(index);p.states[index_uri]='active'
            r['data']['navigation']={'duplicate-current':r['data']['children']['current'],'new-index':index_uri}
            p.bodies[root]=dp.memory_text(r);ev['rootHash']=dp.digest(r)
            result=co.complete(root,imp,ev,state,c)
            self.assertEqual(len(result['archiveMap']),136)
            self.assertTrue(set(new_uris+[index_uri])<=set(result['archiveMap']))
            self.assertEqual(sum(a=='archive' for a,_ in p.mutations),136)
            self.assertEqual(dp.read_json(state)['finalSizeAdmission']['archiveCount'],136)
    def test_initial_fits_final_overflow_zero_native_mutations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp);imp['summary']='x'*19000
            with self.assertRaisesRegex(dp.PlanError,'Final implemented architecture needs'):co.complete(root,imp,ev,state,c)
            self.assertEqual(p.mutations,[]);self.assertEqual(set(p.bodies),set(b))
    def test_60000_60001_full_encoded_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4)
            plan,r=dp.load_plan(root,c)
            ev['padding']=''
            st={'plan':plan,'root':r,'rootUri':root,'records':{k:dp.load_record(v) for k,v in b.items()},'archiveMap':{},'status':'pending'}
            co.admit_final_size(st,imp,ev,c)
            room=60000-st['finalSizeAdmission']['finalBodyBytes']
            # summary occurs in human prose and machine JSON. Parity can be adjusted by evidence (machine only).
            if room%2:ev['padding']='x';co.admit_final_size(st,imp,ev,c);room=60000-st['finalSizeAdmission']['finalBodyBytes']
            imp['summary']+='x'*(room//2)
            co.admit_final_size(st,imp,ev,c)
            self.assertEqual(st['finalSizeAdmission']['finalBodyBytes'],60000)
            ev['padding']+='x'
            with self.assertRaisesRegex(dp.PlanError,'60001 UTF-8 bytes'):co.admit_final_size(st,imp,ev,c)
            self.assertEqual(p.mutations,[])
    def test_legacy_unknown_destinations_zero_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, imp, ev, bodies = fixture(tmp)
            class MissingPlanningTransport:
                workflow = None
                repo = tmp
                def read(self, uri):
                    return bodies[uri]
            original = copy.deepcopy(bodies)
            with self.assertRaisesRegex(dp.PlanError, "no exact destination preflight"):
                co.complete(root, imp, ev, Path(tmp) / "state.json", MissingPlanningTransport())
            self.assertEqual(bodies, original)

    def test_archive_interruption_recovery_reuses_destinations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,5);p.fail_after_archive=True
            with self.assertRaisesRegex(OSError,'Synthetic interruption'):co.complete(root,imp,ev,state,c)
            before=dp.read_json(state);self.assertEqual(before['pending']['operation'],'archive')
            plans=copy.deepcopy(before['archivePlans'])
            result=co.complete(root,imp,ev,state,c)
            self.assertEqual(result['status'],'complete');self.assertEqual(len(result['archiveMap']),5)
            self.assertEqual(sum(a=='archive' for a,_ in p.mutations),5)
            self.assertEqual(dp.read_json(state)['archivePlans'],plans)
    def test_readonly_archive_preflight_interruption_recovers_without_new_intent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,5)
            invoke=c.workflow.invoke;preflights=[0]
            def interrupted(request):
                if request['action']=='preflight' and request.get('mutation')=='archive':
                    preflights[0]+=1
                    if preflights[0]==len(b)+1:raise OSError('Synthetic readonly preflight interrupted')
                return invoke(request)
            c.workflow.invoke=interrupted
            with self.assertRaisesRegex(OSError,'readonly preflight interrupted'):
                co.complete(root,imp,ev,state,c)
            ctx=wt.read_json(c.workflow.path)
            self.assertEqual(ctx['pending']['stage'],'preflight');self.assertNotIn('preview',ctx['pending'])
            self.assertEqual([a for a,_ in p.mutations],['create'])
            plans=dp.read_json(state)['archivePlans']
            c.workflow=wt.WorkflowTransport(c.workflow.path,tmp,tmp,invoke=p)
            result=co.complete(root,imp,ev,state,c)
            self.assertEqual(result['status'],'complete');self.assertEqual(len(result['archiveMap']),5)
            self.assertEqual(sum(a=='archive' for a,_ in p.mutations),5)
            self.assertEqual(dp.read_json(state)['archivePlans'],plans)
    def test_changed_source_before_retirement_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4);p.change_source=True
            with self.assertRaisesRegex(dp.PlanError,'changed during closeout'):co.complete(root,imp,ev,state,c)
            self.assertEqual(sum(a=='archive' for a,_ in p.mutations),0)
    def test_destination_drift_refused_before_retirement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4);p.drift_preflight=True
            with self.assertRaisesRegex(wt.WorkflowError,'destination changed'):co.complete(root,imp,ev,state,c)
            self.assertEqual(sum(a=='archive' for a,_ in p.mutations),0)
    def test_generation_drift_before_any_recovery_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4)
            planned=c.plan_archive(root)
            context=wt.read_json(c.workflow.path);context['binding']['generation']='different'
            wt.save_json(c.workflow.path,context)
            with self.assertRaisesRegex(wt.WorkflowError,'pinned immutable'):c.archive(root,plan=planned)
            self.assertEqual(p.mutations,[])
    def test_pending_recovery_intent_drift_refused_before_native_replay(self):
        for changed in ('expectedRevision','preview','sourceHash'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as tmp:
                root,imp,ev,b,p,c,state=setup(tmp,4)
                plan=c.plan_archive(root)
                context=wt.read_json(c.workflow.path)
                pending={'key':'archive:'+root,'request':copy.deepcopy(plan['request']),
                         'preview':copy.deepcopy(plan['preview']),'sourceBodySha256':plan['sourceBodySha256'],'stage':'mutation'}
                if changed=='preview':pending['preview']['canonicalUri']+='.changed'
                if changed=='sourceHash':pending['sourceBodySha256']='0'*64
                context['pending']=pending;wt.save_json(c.workflow.path,context)
                with self.assertRaises(wt.WorkflowError):
                    c.workflow.archive(root,expected_revision='0'*64 if changed=='expectedRevision' else None,plan=plan)
                self.assertEqual(p.mutations,[])
                self.assertEqual(wt.read_json(c.workflow.path)['pending'],pending)
    def test_full_binding_drift_before_initial_save_is_zero_write(self):
        for field in ('generation','bindingId','workflowRunId'):
            for stage in ('last_archive_plan','before_preflight','before_remember'):
                with self.subTest(field=field,stage=stage), tempfile.TemporaryDirectory() as tmp:
                    root,imp,ev,b,p,c,state=setup(tmp,4)
                    def change_binding():
                        ctx=wt.read_json(c.workflow.path);ctx['binding'][field]='different';wt.save_json(c.workflow.path,ctx)
                    if stage=='last_archive_plan':
                        original=c.plan_archive;count=[0]
                        def wrap(uri):
                            plan=original(uri);count[0]+=1
                            if count[0]==len(b):change_binding()
                            return plan
                        c.plan_archive=wrap
                    elif stage=='before_preflight':
                        original=c.preflight
                        def wrap(*args,**kwargs):change_binding();return original(*args,**kwargs)
                        c.preflight=wrap
                    else:
                        original=c.remember
                        def wrap(*args,**kwargs):change_binding();return original(*args,**kwargs)
                        c.remember=wrap
                    with self.assertRaises(wt.WorkflowError):co.complete(root,imp,ev,state,c)
                    self.assertEqual(p.mutations,[]);self.assertEqual(set(p.bodies),set(b))
    def test_resumed_admission_rejects_new_valid_same_generation_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4)
            def refuse(*args,**kwargs):raise OSError('Synthetic interruption before initial native write')
            original=c.remember;c.remember=refuse
            with self.assertRaises(OSError):co.complete(root,imp,ev,state,c)
            c.remember=original
            ctx=wt.read_json(c.workflow.path);ctx['binding']['bindingId']='different';wt.save_json(c.workflow.path,ctx)
            c.workflow=wt.WorkflowTransport(c.workflow.path,tmp,tmp,invoke=p)
            with self.assertRaisesRegex(wt.WorkflowError,'another full workflow identity'):
                co.complete(root,imp,ev,state,c)
            self.assertEqual(p.mutations,[])
    def test_same_binding_other_helper_cannot_replace_admitted_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4)
            original=c.workflow.recover;interleaved=[False]
            def actor_between_locks(**kwargs):
                if not interleaved[0]:
                    interleaved[0]=True
                    actor=wt.WorkflowTransport(c.workflow.path,tmp,tmp,invoke=p)
                    record=dp.load_record(b[root]);record['title']='Independent helper note'
                    actor.prepare(record,'independent-other',dp.memory_text(record),[],deferred=False)
                    context=wt.read_json(actor.path);context['pending']['stage']='mutation';wt.save_json(actor.path,context)
                return original(**kwargs)
            c.workflow.recover=actor_between_locks
            with self.assertRaisesRegex(wt.WorkflowError,'admitted archive recovery'):
                co.complete(root,imp,ev,state,c)
            self.assertEqual([a for a,_ in p.mutations],['create'])
            self.assertNotIn('threadnote://user/synthetic/memories/durable/projects/synthetic/independent-other.md',p.bodies)
            self.assertEqual(wt.read_json(c.workflow.path)['pending']['request']['artifactKey'],'independent-other')
            self.assertTrue(set(b)<=set(p.bodies))
    def test_cached_127_forecast_refuses_changed_root_before_first_save(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp)
            original=c.remember
            def interrupt(*args,**kwargs):raise OSError('Synthetic interruption before initial write')
            c.remember=interrupt
            with self.assertRaises(OSError):co.complete(root,imp,ev,state,c)
            self.assertEqual(dp.read_json(state)['finalSizeAdmission']['archiveCount'],127)
            r=dp.load_record(p.bodies[root])
            for i in range(9):r['data']['priorArtifacts'][root+f'-new-history-{i}']='new-owner-revision'
            p.bodies[root]=dp.memory_text(r);c.remember=original
            with self.assertRaisesRegex(dp.PlanError,'changed before final-size admission'):
                co.complete(root,imp,ev,state,c)
            self.assertEqual(p.mutations,[])
            self.assertEqual(dp.load_record(p.bodies[root]),r)
    def test_old_pending_requires_reconciliation_zero_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4)
            plan,r=dp.load_plan(root,c)
            st={'schemaVersion':1,'inputHash':dp.digest({'root':root,'implemented':imp,'evidence':ev}),'plan':plan,'root':r,'rootUri':root,'records':{k:dp.load_record(v) for k,v in b.items()},'archiveMap':{},'status':'pending','pending':{'operation':'archive','source':root,'hash':dp.digest(r)}}
            dp.write_json(state,st)
            with self.assertRaisesRegex(dp.PlanError,'predates final-size admission'):co.complete(root,imp,ev,state,c)
            self.assertEqual(p.mutations,[]);self.assertEqual(dp.read_json(state),st)
    def test_initial_save_or_readback_failure_preserves_all_sources(self):
        for stage in ('save','readback'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as tmp:
                root,imp,ev,b,p,c,state=setup(tmp,4)
                if stage=='save':
                    def refuse(*args,**kwargs):raise OSError('Synthetic native current-citation refusal')
                    c.remember=refuse
                else:
                    original=c.read
                    def bad_read(uri):
                        body=original(uri)
                        if uri.endswith('/implemented.md'):
                            r=dp.load_record(body);r['title']+=' changed';return dp.memory_text(r)
                        return body
                    c.read=bad_read
                with self.assertRaises((OSError,dp.PlanError)):
                    co.complete(root,imp,ev,state,c)
                self.assertEqual(sum(a=='archive' for a,_ in p.mutations),0)
                self.assertTrue(set(b)<=set(p.bodies))
                self.assertIn('pending',dp.read_json(state))
    def test_changed_source_before_admission_preserves_all_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4)
            original=c.plan_archive
            count=[0]
            def drift(uri):
                count[0]+=1
                if count[0]==1:
                    later=next(k for k in b if '/target-' in k)
                    r=dp.load_record(p.bodies[later]);r['title']+=' changed';p.bodies[later]=dp.memory_text(r)
                return original(uri)
            c.plan_archive=drift
            with self.assertRaisesRegex(dp.PlanError,'changed before final-size admission'):
                co.complete(root,imp,ev,state,c)
            self.assertEqual(p.mutations,[])
    def test_context_pin_drift_blocks_before_archive_planning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4)
            uri='threadnote://user/synthetic/memories/durable/projects/synthetic/context.md'
            r=dp.load_record(b[root]);r['kind']='current';r['data']={'summary':'Context','diagram':'flowchart LR\n A-->B','invariants':[],'unknowns':[]}
            p.bodies[uri]=dp.memory_text(r);p.states[uri]='active'
            imp['contextRefs']=[uri];imp['recallSources']=[{'uri':uri,'sha256':'0'*64}]
            with self.assertRaisesRegex(dp.PlanError,'Relevant memory changed'):
                co.complete(root,imp,ev,state,c)
            self.assertEqual(p.mutations,[]);self.assertEqual(p.planned,{})
    def test_source_snapshot_freshness_still_blocks_before_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4)
            (Path(tmp)/'source.py').write_text('value = 2\n')
            with self.assertRaisesRegex(dp.PlanError,'Scoped source changed'):
                co.complete(root,imp,ev,state,c)
            self.assertEqual(p.mutations,[])
    def test_cloud_guard_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,imp,ev,b,p,c,state=setup(tmp,4)
            c.workflow.state['binding']['profile']='codex-cloud-personal'
            with self.assertRaisesRegex(wt.WorkflowError,'pending approved'):co.complete(root,imp,ev,state,c)
            self.assertEqual(p.mutations,[])

if __name__=='__main__':unittest.main(verbosity=2)
