import { getSchema, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import CodeBlock from "@tiptap/extension-code-block";
import Image from "@tiptap/extension-image";
import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import UniqueID from "@tiptap/extension-unique-id";

// Validation schema is headless and never parses or renders untrusted HTML.
// Match the node catalogue used by both standalone and embedded clients.
let schema:ReturnType<typeof getSchema>|undefined;
export function richSchema(){
  return schema??=getSchema([
    StarterKit.configure({heading:{levels:[1,2,3]},codeBlock:false}),TextStyle,Color,Highlight.configure({multicolor:true}),TaskList,TaskItem.configure({nested:true}),TableKit,
    CodeBlock,Image.extend({addAttributes(){const parent={...(this.parent?.()??{})};delete (parent as {height?:unknown}).height;return {...parent,attachmentId:{default:null},caption:{default:""},width:{default:640}};}}),
    Details,DetailsContent,DetailsSummary,
    Node.create({name:"callout",group:"block",content:"paragraph+",addAttributes(){return {theme:{default:"neutral"},icon:{default:"✦"}};}}),
    Node.create({name:"tableOfContents",group:"block",atom:true}),
    Node.create({name:"pageLink",group:"block",atom:true,addAttributes(){return {pageId:{default:null}};}}),
    Node.create({name:"file",group:"block",atom:true,addAttributes(){return {attachmentId:{default:null},title:{default:""}};}}),
    Node.create({name:"recordRef",group:"block",atom:true,addAttributes(){return {nodeVersion:{default:1},recordId:{default:null},collectionId:{default:null},display:{default:"chip"},fields:{default:[]}};}}),
    Node.create({name:"recordView",group:"block",atom:true,addAttributes(){return {nodeVersion:{default:1},viewId:{default:null},collectionId:{default:null},layout:{default:"table"},columns:{default:["name"]},limit:{default:10}};}}),
    UniqueID.configure({types:["paragraph","heading","bulletList","orderedList","listItem","taskList","taskItem","horizontalRule","blockquote","callout","codeBlock","table","tableRow","tableCell","tableHeader","image","file","details","detailsSummary","detailsContent","tableOfContents","pageLink","recordRef","recordView"],attributeName:"id"}),
  ]);
}
