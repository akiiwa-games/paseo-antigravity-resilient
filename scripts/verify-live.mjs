// Opt-in integration probe against a real local Paseo daemon and logged-in agy.
// Uses model quota. Commands run in a reusable dedicated fixture directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import {WebSocket} from 'ws';

const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:fallback;};
const model=arg('--model','gemini-4-argon-high');
const output=path.resolve(arg('--output',path.join(os.tmpdir(),`paseo-agy-live-${Date.now()}`)));
fs.mkdirSync(output,{recursive:true});
// Keep one fixture/workspace across runs; output directories only hold evidence.
const fixture=path.resolve(arg('--fixture',path.join(os.tmpdir(),'paseo-antigravity-live-fixture')));
const workspaceId=arg('--workspace',undefined);
fs.mkdirSync(fixture,{recursive:true});
fs.writeFileSync(path.join(fixture,'AGENTS.md'),'Integration fixture. Only execute the explicitly requested probes. No delegation, no outside files, no repository changes.\n');
fs.writeFileSync(path.join(fixture,'probe.py'),'import time\nprint("TOOL_STARTED", flush=True)\ntime.sleep(4)\nprint("TOOL_FINISHED", flush=True)\n');
fs.writeFileSync(path.join(fixture,'slow.py'),'import os,time,pathlib\npathlib.Path("slow.pid").write_text(str(os.getpid()))\nprint("SLOW_STARTED", flush=True)\ntime.sleep(90)\n');
fs.rmSync(path.join(fixture,'slow.pid'),{force:true});
const home=process.env.PASEO_HOME||path.join(os.homedir(),'.paseo');
const cfg=JSON.parse(fs.readFileSync(path.join(home,'config.json'),'utf8'));
const client=new DaemonClient({url:`ws://${cfg.daemon?.listen||'127.0.0.1:6767'}/ws`,
  clientId:randomUUID(),clientType:'cli',appVersion:'0.11.2',connectTimeoutMs:30000,
  localCredential:()=>fs.readFileSync(path.join(home,'local-credential'),'utf8').trim(),
  webSocketFactory:(url,c)=>new WebSocket(url,{headers:c?.headers,protocols:c?.protocols}),reconnect:{enabled:false}});
const types=new Set(['assistant_message','reasoning','tool_call']);
function items(value,result=[]){
  if(!value||typeof value!=='object')return result;
  if(types.has(value.type)){
    result.push({...value,id:value.id??value.messageId??value.callId??`${value.type}:${value.text}`});
    return result;
  }
  for(const v of Object.values(value))if(v&&typeof v==='object')items(v,result);
  return result;
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(predicate,label,timeout=180000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await predicate())return;await delay(500);}
  throw new Error(`Timed out: ${label}`);
}
let agentId;let canaryPluginId;const live=[];let slowPid;
const startTime=Date.now();
const summary={model,output,fixture,workspaceId,checks:{}};
await client.connect();
try{
  let providerId='antigravity-resilient';
  if(process.argv.includes('--reload')){
    const plugin=await client.reloadPlugin('antigravity-resilient-provider');
    assert.equal(plugin.status,'running');
    summary.pluginPath=plugin.path;
  }else{
    const repoRoot=process.cwd();
    const canaryDir=path.join(output,'canary-plugin');
    canaryPluginId='antigravity-resilient-canary-provider';
    providerId='antigravity-resilient-canary';
    fs.mkdirSync(canaryDir,{recursive:true});
    for(const entry of ['package.json','paseo-plugin.json','icon.svg','index.server.ts','server','shared']){
      const src=path.join(repoRoot,entry);
      if(fs.existsSync(src))fs.cpSync(src,path.join(canaryDir,entry),{recursive:true});
    }
    const manifestPath=path.join(canaryDir,'paseo-plugin.json');
    const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    manifest.id=canaryPluginId;
    manifest.name='Antigravity Resilient (Canary Probe)';
    fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2));
    const providerPath=path.join(canaryDir,'server','provider.ts');
    fs.writeFileSync(providerPath,fs.readFileSync(providerPath,'utf8')
      .replace('export const PROVIDER_ID = "antigravity-resilient";',`export const PROVIDER_ID = "${providerId}";`)
      .replace('export const PLUGIN_ID = "antigravity-resilient-provider";',`export const PLUGIN_ID = "${canaryPluginId}";`));
    const entryPath=path.join(canaryDir,'index.server.ts');
    fs.writeFileSync(entryPath,'import type { PluginServerContext } from "@getpaseo/plugin/server";\nimport { antigravityResilientProvider } from "./server/provider.ts";\nexport default function contribute(server: PluginServerContext) {\n  server.registerProvider(antigravityResilientProvider);\n  return () => {};\n}\n');
    const installed=await client.installDirectoryPlugin(canaryDir,canaryPluginId);
    assert.equal(installed?.status,'running');
    summary.pluginPath=canaryDir;
    summary.canaryPluginId=canaryPluginId;
  }
  const created=await client.createAgent({provider:providerId,cwd:fixture,...(workspaceId?{workspaceId}:{}),model,modeId:'full-access',
    title:'Antigravity streaming integration probe',idempotencyKey:randomUUID()});
  agentId=created.id;summary.agentId=agentId;
  client.subscribeAgentTimeline(agentId,message=>{
    const row={at:Date.now(),message};live.push(row);
    fs.appendFileSync(path.join(output,'live-timeline.jsonl'),JSON.stringify(row)+'\n');
  });
  await client.sendMessage(agentId,'Integration test. First say PRE_TOOL_MARKER as a progress message. Execute python probe.py exactly once in the current directory and wait for completion. Say POST_TOOL_MARKER, then execute python -c "print(2+3)". Finally write FINAL_MARKER followed by 40 numbered lines about the two commands and end with END_MARKER. Put each marker on its own line exactly once; do not quote markers inside the numbered explanation. Do not read outside this directory, change files or delegate.');
  let finalTimeline;
  await wait(async()=>{
    const a=await client.fetchAgent(agentId);const snap=a?.agent||a;
    if(snap?.status==='error')throw new Error(`Probe failed: ${JSON.stringify(snap.lastError)}`);
    finalTimeline=await client.fetchAgentTimeline(agentId);
    return snap?.status==='idle'&&items(finalTimeline).some(i=>i.type==='assistant_message'&&i.text.includes('END_MARKER'));
  },'streaming turn');
  fs.writeFileSync(path.join(output,'completed-timeline.json'),JSON.stringify(finalTimeline,null,2));
  const finalItems=items(finalTimeline);
  const messages=finalItems.filter(i=>i.type==='assistant_message');
  const text=messages.map(i=>i.text).join('\n');
  // References to a marker inside prose are not duplicated progress messages.
  const markerLines=text.split(/\r?\n/).map(line=>line.trim());
  for(const marker of ['PRE_TOOL_MARKER','POST_TOOL_MARKER','FINAL_MARKER','END_MARKER'])assert.equal(markerLines.filter(line=>line===marker).length,1,`${marker} line exactly once`);
  assert.equal(finalItems.filter(i=>i.type==='tool_call'&&i.status==='running').length,0);
  const liveItems=live.flatMap(row=>items(row.message).map(item=>({at:row.at,item})));
  const progress=liveItems.findIndex(x=>x.item.type==='assistant_message'&&x.item.text.includes('PRE_TOOL_MARKER'));
  const tool=liveItems.findIndex(x=>x.item.type==='tool_call');
  assert.ok(progress>=0&&tool>progress,'progress before tool');
  const finalId=messages.find(i=>i.text.includes('FINAL_MARKER')).id;
  const sizes=new Set(liveItems.filter(x=>x.item.id===finalId).map(x=>x.item.text?.length));
  assert.ok(sizes.size>2,'final text streams in multiple distinct sizes');
  const thoughts=finalItems.filter(i=>i.type==='reasoning');
  assert.ok(thoughts.length>0,'native intermediate thinking reaches Paseo');
  summary.checks.streaming={liveEvents:live.length,finalTextUpdates:sizes.size,reasoningItems:thoughts.length,toolCalls:finalItems.filter(i=>i.type==='tool_call').length,characters:text.length};
  console.log(JSON.stringify({stage:'streaming',...summary.checks.streaming}));

  await client.sendMessage(agentId,'Without tools: recall the number printed by the second command. Reply only RESUME_MARKER followed by that number.');
  await wait(async()=>{
    const a=await client.fetchAgent(agentId);const t=await client.fetchAgentTimeline(agentId);
    return (a?.agent||a)?.status==='idle'&&items(t).some(i=>i.type==='assistant_message'&&/RESUME_MARKER\s+5/.test(i.text));
  },'same conversation continuation');
  summary.checks.continuation=true;

  await client.sendMessage(agentId,'Use write_file to create sample.txt in the current directory with content "alpha\\n", then use edit_file on sample.txt to replace "alpha" with "beta", then use read_file to read sample.txt. Finally reply with a single markdown message that includes the literal code span `<thought>` followed on the next line by THOUGHT_TAG_SURVIVED_MARKER.');
  let parityTimeline;
  await wait(async()=>{
    const a=await client.fetchAgent(agentId);const snap=a?.agent||a;
    if(snap?.status==='error')throw new Error(`Tool/thought probe failed: ${JSON.stringify(snap.lastError)}`);
    parityTimeline=await client.fetchAgentTimeline(agentId);
    return snap?.status==='idle'&&items(parityTimeline).some(i=>i.type==='assistant_message'&&i.text.includes('THOUGHT_TAG_SURVIVED_MARKER'));
  },'canonical tools and <thought> tag parity turn');
  fs.writeFileSync(path.join(output,'parity-timeline.json'),JSON.stringify(parityTimeline,null,2));
  const parityItems=items(parityTimeline);
  const toolDetailTypes=new Set(parityItems.filter(i=>i.type==='tool_call').map(i=>i.detail?.type));
  for(const expectedType of ['shell','write','edit','read']){
    assert.ok(toolDetailTypes.has(expectedType),`expected canonical tool detail type ${expectedType}`);
  }
  const thoughtMsg=parityItems.find(i=>i.type==='assistant_message'&&i.text.includes('THOUGHT_TAG_SURVIVED_MARKER'));
  assert.ok(thoughtMsg&&thoughtMsg.text.includes('<thought>'),'literal <thought> tag preserved without truncation');
  const thoughtMsgRows=parityItems.filter(i=>i.type==='assistant_message'&&i.id===thoughtMsg.id);
  assert.equal(thoughtMsgRows.length,1,'thought message must not be split into multiple live bubbles by late reasoning');
  assert.equal(parityItems.filter(i=>i.type==='assistant_message'&&String(i.id||'').endsWith(':message:1')).length,0,'no duplicate :message:1 fallback bubble');
  summary.checks.toolAndThoughtParity={
    canonicalToolTypes:[...toolDetailTypes].sort(),
    thoughtTagUntruncated:true,
    thoughtMessageBubbles:thoughtMsgRows.length,
    thoughtMessageLength:thoughtMsg.text.length,
  };
  console.log(JSON.stringify({stage:'toolAndThoughtParity',...summary.checks.toolAndThoughtParity}));

  await client.refreshAgent(agentId);
  const replay=await client.fetchAgentTimeline(agentId);
  fs.writeFileSync(path.join(output,'replayed-timeline.json'),JSON.stringify(replay,null,2));
  assert.ok(items(replay).some(i=>i.type==='assistant_message'&&i.text.includes('END_MARKER')));
  assert.ok(items(replay).some(i=>i.type==='assistant_message'&&i.text.includes('THOUGHT_TAG_SURVIVED_MARKER')));
  summary.checks.replay=true;

  // Simulate agy's 500-conversation cap evicting <conversationId>.db from ~/.gemini/antigravity-cli/conversations/
  const storeDir=path.join(home,'antigravity-resilient','conversations');
  const convFile=fs.readdirSync(storeDir).find(f=>{
    if(!f.endsWith('.json')||f.endsWith('.compaction.json'))return false;
    const p=path.join(storeDir,f);
    try{
      return fs.statSync(p).mtimeMs>=startTime&&fs.readFileSync(p,'utf8').includes('THOUGHT_TAG_SURVIVED_MARKER');
    }catch{return false;}
  });
  assert.ok(convFile,'expected durable store snapshot for probe conversation');
  const evictedConvId=convFile.replace(/\.json$/,'');
  const agyConvDir=path.join(os.homedir(),'.gemini','antigravity-cli','conversations');
  for(const ext of ['.db','.db-wal','.db-shm','.pb']){
    fs.rmSync(path.join(agyConvDir,`${evictedConvId}${ext}`),{force:true});
  }
  await client.sendMessage(agentId,'Without tools: recall the word written to sample.txt after editing. Reply only EVICTED_RECOVERY_MARKER followed by that word.');
  let recoveryTimeline;
  await wait(async()=>{
    const a=await client.fetchAgent(agentId);const snap=a?.agent||a;
    if(snap?.status==='error')throw new Error(`Evicted DB recovery failed: ${JSON.stringify(snap.lastError)}`);
    recoveryTimeline=await client.fetchAgentTimeline(agentId);
    return snap?.status==='idle'&&items(recoveryTimeline).some(i=>i.type==='assistant_message'&&/EVICTED_RECOVERY_MARKER\s+beta/i.test(i.text));
  },'evicted <conversationId>.db history recovery');
  fs.writeFileSync(path.join(output,'evicted-recovery-timeline.json'),JSON.stringify(recoveryTimeline,null,2));
  summary.checks.evictedDbRecovery={evictedConversationId:evictedConvId,recovered:true};
  console.log(JSON.stringify({stage:'evictedDbRecovery',...summary.checks.evictedDbRecovery}));

  await client.sendMessage(agentId,'Run python slow.py exactly once in this directory. Wait for completion. Do not use other tools, change any files or delegate. This integration test will cancel the command shortly.');
  await wait(()=>fs.existsSync(path.join(fixture,'slow.pid')),'slow command start');
  slowPid=Number(fs.readFileSync(path.join(fixture,'slow.pid'),'utf8'));
  await client.cancelAgent(agentId);
  await wait(()=>{try{process.kill(slowPid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}},'canceled command process exits',15000);
  const canceled=await client.fetchAgentTimeline(agentId);
  fs.writeFileSync(path.join(output,'canceled-timeline.json'),JSON.stringify(canceled,null,2));
  assert.equal(items(canceled).filter(i=>i.type==='tool_call'&&i.status==='running').length,0,'no spinning tool after cancel');
  summary.checks.cancellation={childPid:slowPid,childExited:true};
  console.log(JSON.stringify({stage:'completed',checks:summary.checks}));
}catch(error){summary.error=error.stack;process.exitCode=1;console.error(error.message);}
finally{
  if(agentId){
    await client.cancelAgent(agentId).catch(e=>{summary.cleanupError=String(e);});
    await client.archiveAgent(agentId).catch(e=>{summary.cleanupError=String(e);});
    await client.deleteAgent(agentId).catch(e=>{summary.cleanupError=String(e);});
  }
  if(canaryPluginId){
    await client.removePlugin(canaryPluginId).catch(e=>{summary.cleanupError=String(e);});
  }
  await client.close();
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
  console.log(`Evidence: ${output}`);
}
