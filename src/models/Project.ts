export interface Project {
  groupId: string;
  fileId: string;
  folderId: string;
  botId: string;
  keyword: string;
  replacements: { [key: string]: string };
  subject: string;
}
