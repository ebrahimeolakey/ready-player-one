import {forwardRef,useMemo} from 'react';
import CodeMirror,{type ReactCodeMirrorProps,type ReactCodeMirrorRef} from '@uiw/react-codemirror';
import {EditorState,RangeSetBuilder,type Extension} from '@codemirror/state';
import {Decoration,EditorView,ViewPlugin,highlightWhitespace,type DecorationSet,type ViewUpdate} from '@codemirror/view';
import {indentUnit} from '@codemirror/language';
import {useEditorSettings} from './EditorSettings';
import type {EditorSettingsValue} from '../core/editor-settings.mjs';

function guides(width:number) {
 const decorate=(view:EditorView)=>{
  const builder=new RangeSetBuilder<Decoration>();
  for(const {from,to} of view.visibleRanges)for(let pos=from;pos<=to;){
   const line=view.state.doc.lineAt(pos);let columns=0;
   for(const char of line.text){if(char===' ')columns++;else if(char==='\t')columns+=width-columns%width;else break;}
   if(columns>=width)builder.add(line.from,line.from,Decoration.line({attributes:{style:`background-image:repeating-linear-gradient(to right,transparent 0,transparent calc(${width}ch - 1px),#58655c55 calc(${width}ch - 1px),#58655c55 ${width}ch);background-size:${columns}ch 100%;background-repeat:no-repeat;background-position:6px 0;`}}));
   if(line.to>=to)break;pos=line.to+1;
  }
  return builder.finish();
 };
 return ViewPlugin.fromClass(class{decorations:DecorationSet;constructor(view:EditorView){this.decorations=decorate(view);}update(update:ViewUpdate){if(update.docChanged||update.viewportChanged)this.decorations=decorate(update.view);}},{decorations:v=>v.decorations});
}
function minimap() {
 return ViewPlugin.fromClass(class {
  canvas:HTMLCanvasElement;observer:ResizeObserver;frame=0;destroyed=false;view:EditorView;
  constructor(view:EditorView){
   this.view=view;this.canvas=document.createElement('canvas');this.canvas.className='rpo-code-minimap';this.canvas.tabIndex=0;this.canvas.setAttribute('role','button');this.canvas.setAttribute('aria-label','代码缩略图，点击或上下键定位');view.dom.appendChild(this.canvas);
   this.canvas.addEventListener('pointerdown',this.pointerDown);this.canvas.addEventListener('pointermove',this.pointerMove);this.canvas.addEventListener('keydown',this.keyDown);view.scrollDOM.addEventListener('scroll',this.schedule);
   this.observer=new ResizeObserver(this.schedule);this.observer.observe(view.dom);this.schedule();
  }
  schedule=()=>{if(!this.frame&&!this.destroyed)this.frame=requestAnimationFrame(()=>{this.frame=0;this.draw();});};
  update(update:ViewUpdate){if(update.docChanged||update.viewportChanged||update.geometryChanged)this.schedule();}
  jump=(fraction:number)=>{const line=Math.max(1,Math.min(this.view.state.doc.lines,Math.round(fraction*this.view.state.doc.lines)));this.view.dispatch({effects:EditorView.scrollIntoView(this.view.state.doc.line(line).from,{y:'center'})});};
  pointerDown=(event:PointerEvent)=>{event.preventDefault();this.canvas.setPointerCapture(event.pointerId);this.jump((event.clientY-this.canvas.getBoundingClientRect().top)/this.canvas.clientHeight);};
  pointerMove=(event:PointerEvent)=>{if(event.buttons===1)this.jump((event.clientY-this.canvas.getBoundingClientRect().top)/this.canvas.clientHeight);};
  keyDown=(event:KeyboardEvent)=>{if(!['ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))return;event.preventDefault();const current=this.view.state.doc.lineAt(this.view.viewport.from).number/this.view.state.doc.lines;this.jump(event.key==='Home'?0:event.key==='End'?1:current+(event.key==='ArrowUp'||event.key==='PageUp'?-0.08:0.08));};
  draw(){
   if(this.destroyed)return;const width=78,height=Math.max(1,this.canvas.clientHeight),ratio=window.devicePixelRatio||1;
   this.canvas.width=Math.ceil(width*ratio);this.canvas.height=Math.ceil(height*ratio);const context=this.canvas.getContext('2d');if(!context)return;context.scale(ratio,ratio);context.clearRect(0,0,width,height);
   const doc=this.view.state.doc,rows=Math.max(1,Math.floor(height)),stride=Math.max(1,Math.ceil(doc.lines/rows));context.fillStyle='#86988d';
   // At most one sampled line per canvas pixel and 200 columns per line. Large
   // files remain bounded; this overview intentionally is not syntax-highlighted.
   for(let n=1;n<=doc.lines;n+=stride){const line=doc.line(n).text.slice(0,200),y=(n-1)/doc.lines*height;let column=0,start=-1;
    for(const char of line){const step=char==='\t'?this.view.state.tabSize-column%this.view.state.tabSize:1;if(/\s/.test(char)){if(start>=0){context.fillRect(3+start*.35,y,Math.max(1,(column-start)*.35),1);start=-1;}}else if(start<0)start=column;column+=step;}
    if(start>=0)context.fillRect(3+start*.35,y,Math.max(1,(column-start)*.35),1);
   }
   const visible=this.view.visibleRanges;if(visible.length){const from=doc.lineAt(visible[0].from).number-1,to=doc.lineAt(visible.at(-1)!.to).number;const y=from/doc.lines*height,h=Math.max(3,(to-from)/doc.lines*height);context.fillStyle='#9ee3b52b';context.fillRect(0,y,width,h);context.strokeStyle='#99cdaa70';context.strokeRect(.5,y+.5,width-1,h);}
  }
  destroy(){this.destroyed=true;cancelAnimationFrame(this.frame);this.observer.disconnect();this.view.scrollDOM.removeEventListener('scroll',this.schedule);this.canvas.removeEventListener('pointerdown',this.pointerDown);this.canvas.removeEventListener('pointermove',this.pointerMove);this.canvas.removeEventListener('keydown',this.keyDown);this.canvas.remove();}
 });
}
export function editorSettingsExtensions(settings:EditorSettingsValue):Extension[] {
 const extensions:Extension[]=[EditorState.tabSize.of(settings.indentWidth),indentUnit.of(settings.insertSpaces?' '.repeat(settings.indentWidth):'\t'),EditorView.theme({
  '&.cm-editor':{fontSize:`${settings.fontSize}px`,height:'100%'},'.cm-scroller':{fontFamily:`"${settings.fontFamily}",ui-monospace,SFMono-Regular,Menlo,monospace`,lineHeight:String(settings.lineHeight),fontVariantLigatures:settings.ligatures?'normal':'none',paddingRight:settings.minimap?'84px':'0'},'.cm-content':{fontFeatureSettings:settings.ligatures?'"liga" 1, "calt" 1':'"liga" 0, "calt" 0'},'.rpo-code-minimap':{position:'absolute',right:'0',top:'0',width:'78px',height:'100%',backgroundColor:'#111713',borderLeft:'1px solid #303b32',cursor:'pointer',zIndex:'3',touchAction:'none'}})];
 if(settings.wordWrap==='on')extensions.push(EditorView.lineWrapping);
 if(settings.renderWhitespace)extensions.push(highlightWhitespace());
 if(settings.indentGuides)extensions.push(guides(settings.indentWidth));
 if(settings.minimap)extensions.push(minimap());
 return extensions;
}
export const CodeEditor=forwardRef<ReactCodeMirrorRef,ReactCodeMirrorProps>(function CodeEditor(props,ref){
 const settings=useEditorSettings(),key=JSON.stringify(settings),extensions=useMemo(()=>editorSettingsExtensions(settings),[key]);
 return <CodeMirror {...props} className={["rpo-code-editor",props.className].filter(Boolean).join(" ")} ref={ref} extensions={[...(props.extensions||[]),...extensions]}/>;
});
