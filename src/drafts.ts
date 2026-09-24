export async function readDraft(key:string):Promise<string|null>{
 const saved=await window.rpo.invoke('draft.read',{key});
 const legacy=localStorage.getItem(key);
 if(saved!==null){if(legacy!==null)localStorage.removeItem(key);return saved;}
 if(legacy!==null){await window.rpo.invoke('draft.set',{key,value:legacy});localStorage.removeItem(key);return legacy;}
 return null;
}
export async function writeDraft(key:string,value:string){await window.rpo.invoke('draft.set',{key,value});localStorage.removeItem(key);}
export async function removeDraft(key:string){await window.rpo.invoke('draft.remove',{key});localStorage.removeItem(key);}
