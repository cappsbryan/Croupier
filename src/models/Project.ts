export interface Project {
  groupId: string;
  fileId: "!";
  folderId: string;
  botId: string;
  keyword: string;
  replacements: { [key: string]: string };
  emojis: string[];
  subject: string;
}
