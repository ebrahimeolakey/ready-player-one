export class DraftStore {
  constructor(store){this.store=store;this.values=store.exists('drafts.json')?store.readJSON('drafts.json'):{};}
  key(key){if(typeof key!=='string'||key.length>1500||!/^rpo-(prompt|file)-/.test(key))throw Error('草稿标识无效');return key;}
  read(key){return this.values[this.key(key)]??null;}
  set(key,value){this.key(key);if(typeof value!=='string'||value.length>6*1024*1024)throw Error('草稿过大');const next={...this.values,[key]:value};if(JSON.stringify(next).length>64*1024*1024)throw Error('本机草稿超过存储上限，请清理旧草稿');this.store.writeJSON('drafts.json',next);this.values=next;return true;}
  remove(key){this.key(key);const next={...this.values};delete next[key];this.store.writeJSON('drafts.json',next);this.values=next;return true;}
}
