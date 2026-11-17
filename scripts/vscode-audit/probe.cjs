// Development-only probe. Loaded in an isolated VS Code window, never shipped in the VSIX.
const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");
const {performance} = require("node:perf_hooks");
exports.activate = async (context) => {
  const output = vscode.workspace.getConfiguration("workspaceMapAudit").get("output");
  if (!output) return;
  const write = async (name, value) => {
    await fs.mkdir(output, {recursive:true});
    await fs.writeFile(path.join(output,name+".json"),JSON.stringify(value,null,2));
  };
  const snapshot = async () => {
    const extensions = vscode.extensions.all.map(e=>({id:e.id,active:e.isActive,
      kind:e.extensionKind,path:e.extensionUri.toString(),version:e.packageJSON.version}));
    const tools = (vscode.lm?.tools ?? []).map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema,tags:t.tags}));
    const value = {at:Date.now(),pid:process.pid,hostMemory:process.memoryUsage(),
      cpu:process.cpuUsage(),version:vscode.version,extensions,tools,
      workspace:vscode.workspace.workspaceFolders?.map(f=>f.uri.toString()),
      buffers:vscode.workspace.textDocuments.map(d=>({uri:d.uri.toString(),version:d.version,dirty:d.isDirty,language:d.languageId}))};
    await write("snapshot",value);return value;
  };
  context.subscriptions.push(vscode.commands.registerCommand("workspaceMapAudit.snapshot",snapshot));
  context.subscriptions.push(vscode.commands.registerCommand("workspaceMapAudit.exercise",async()=>{
    const folder=vscode.workspace.workspaceFolders?.find(f=>f.name==="Audit fixture");
    if(!folder)throw Error("Audit fixture missing");
    const uri=vscode.Uri.joinPath(folder.uri,"sample.ts");
    const document=await vscode.workspace.openTextDocument(uri);
    const original=document.getText();const results=[];
    for(let n=0;n<12;n++){
      const start=performance.now();await vscode.window.showTextDocument(document);
      const pos=new vscode.Position(1,24);
      const definitions=await vscode.commands.executeCommand("vscode.executeDefinitionProvider",uri,pos);
      const references=await vscode.commands.executeCommand("vscode.executeReferenceProvider",uri,new vscode.Position(0,16));
      const edit=new vscode.WorkspaceEdit();edit.insert(uri,document.positionAt(document.getText().length),"// audit edit\n");
      await vscode.workspace.applyEdit(edit);
      const dirty=document.isDirty;
      const revert=new vscode.WorkspaceEdit();revert.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),original);
      await vscode.workspace.applyEdit(revert);await document.save();
      results.push({ms:performance.now()-start,definitions:definitions?.length??0,references:references?.length??0,dirty});
    }
    for(const name of ["notes.md","sample.py"]){const doc=await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri,name));await vscode.window.showTextDocument(doc);}
    await write("exercise",{at:Date.now(),results});await snapshot();return results;
  }));
  const commands=await vscode.commands.getCommands(true);
  await write("commands",commands.filter(c=>/paste|extensionHostProfile|extension.*[Pp]rofil|[Cc]opilot|[Aa]gent.*[Hh]ost/.test(c)));
  await snapshot();
  // Private file control avoids relying on focused keyboard shortcuts during sampling.
  // The probe is development-only and its actions are limited to the audit fixture.
  let lastControl, running = Promise.resolve();
  const handleControl = async () => {
    const control = await fs.readFile(path.join(__dirname,"control.json"),"utf8").then(JSON.parse,()=>null);
    if (!control || control.id === lastControl) return;
    lastControl=control.id;
    const fixture=vscode.workspace.workspaceFolders?.find(f=>f.name==="Audit fixture");
    if(!fixture)return;
    const start=performance.now();
    try {
      let result;
      if(control.action==="snapshot") result=await snapshot();
      else if(control.action==="exercise") result=await vscode.commands.executeCommand("workspaceMapAudit.exercise");
      else if(control.action==="openNotes" || control.action==="paste"){
        const uri=vscode.Uri.joinPath(fixture.uri,"notes.md");
        const doc=await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc,{preview:false});
        if(control.action==="paste"){
          await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
          await new Promise(r=>setTimeout(r,1200));
          result={text:doc.getText(),dirty:doc.isDirty};await doc.save();
        }else result={uri:uri.toString()};
      }else if(control.action==="toolQuery"){
        const uri=vscode.Uri.joinPath(fixture.uri,"sample.ts");
        const tool=await vscode.lm.invokeTool("vscode_listCodeUsages",{input:{symbol:"greet",uri:uri.toString(),lineContent:'export const result = greet("world");'},toolInvocationToken:undefined});
        result={copilotDisabled:vscode.workspace.getConfiguration("chat").get("disableAIFeatures"),content:tool.content.map(p=>({type:p.constructor.name,value:p.value}))};
      }else if(control.action==="closeEditors"){
        if(vscode.workspace.textDocuments.some(d=>d.isDirty))throw Error("Dirty document remains");
        result=await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }else throw Error("Unknown audit action");
      await write("control-result",{id:control.id,action:control.action,ms:performance.now()-start,result});
    }catch(error){await write("control-result",{id:control.id,action:control.action,error:String(error),ms:performance.now()-start});}
  };
  const watcher=require("node:fs").watch(__dirname,{persistent:false},(_event,name)=>{
    if(name?.toString()==="control.json") running=running.then(handleControl).catch(()=>{});
  });
  context.subscriptions.push({dispose:()=>watcher.close()});
};
