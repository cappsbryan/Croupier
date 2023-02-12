import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

import { Convert, GroupMeCallback } from "./dtos/GroupMeCallback";
import { dynamoDbClient, ProjectTableClient } from "./dynamoDbClient";
import { Image } from "./models/Image";
import { Project } from "./models/Project";
import { badRequest, internalServerError, notFound, ok } from "./responses";

export async function receiveMessage(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!event.body) throw badRequest();

  let groupMeCallback: GroupMeCallback;
  try {
    groupMeCallback = Convert.toGroupMeCallback(event.body);
  } catch (e) {
    return badRequest(e.message);
  }

  const project = await getProject(groupMeCallback.group_id);
  if (!project)
    return internalServerError(
      `Failed to retrieve project associated with group: ${groupMeCallback.group_id}`
    );

  if (!isFirstWord(groupMeCallback.text, project.keyword)) {
    return ok({
      groupId: groupMeCallback.group_id,
      message: `Ignored message not starting with '${project.keyword}'`,
    });
  }

  const search = extractSearch(groupMeCallback.text, project.keyword);
  const eligibleImages = await searchForImages(search, project);
  const image = selectImage(eligibleImages);
  if (!image)
    return ok({
      groupId: groupMeCallback.group_id,
      image: null,
    });
  await postImage(image.uri, project.botId);
  await markAsPosted(project.groupId, image.fileId);

  return ok({
    groupId: groupMeCallback.group_id,
    fileId: image.fileId,
    uri: image.uri,
  });
}

const neededProjectKeys = [
  "groupId",
  "botId",
  "keyword",
  "replacements",
] as const;

async function getProject(
  groupId: string
): Promise<Pick<Project, typeof neededProjectKeys[number]> | undefined> {
  const dynamoDb = dynamoDbClient();
  const attributes = await dynamoDb.get({
    Key: {
      groupId: groupId,
      fileId: "!",
    },
    ProjectionExpression: neededProjectKeys.join(", "),
  });

  return attributes.Item as
    | Pick<Project, typeof neededProjectKeys[number]>
    | undefined;
}

function isFirstWord(full: string, word: string): boolean {
  const words = full.split(" ");
  if (words.length < 1) return false;
  return words[0].toLowerCase() == word;
}

function extractSearch(full: string, keyword: string): string | undefined {
  const searchBeginIndex = keyword.length + 1;
  if (full.length <= searchBeginIndex) return undefined;
  return full.substring(searchBeginIndex).toLowerCase();
}

const neededImageKeys = ["fileId", "uri", "posted"] as const;

async function searchForImages(
  search: string | undefined,
  project: Pick<Project, "groupId" | "replacements">
): Promise<Pick<Image, typeof neededImageKeys[number]>[]> {
  const dynamoDb = dynamoDbClient();
  const filter = filterBasedOnSearch(search, project.replacements);

  const attributes = await dynamoDb.fullQuery({
    KeyConditionExpression: "groupId = :groupId AND fileId > :fileId",
    ExpressionAttributeValues: {
      ":groupId": project.groupId,
      ":fileId": "!",
      ...filter?.expressionAttributeValues,
    },
    FilterExpression: filter?.filterExpression,
    ProjectionExpression: neededImageKeys.join(", "),
  });

  const images = attributes.Items as
    | Pick<Image, typeof neededImageKeys[number]>[]
    | undefined;
  return images || [];
}

function filterBasedOnSearch(
  search: string | undefined,
  replacements: Record<string, string>
) {
  // no filter needed if there's no search
  if (!search) return;

  const replacedWords = search.split(" ").map((word, index) => ({
    placeholder: `:${index}`,
    value: replacements[word] ?? word,
  }));
  const filterExpression = replacedWords
    .map((word) => `contains(fname, ${word.placeholder})`)
    .join(" AND ");
  const expressionAttributeValues = Object.fromEntries(
    replacedWords.map((word) => [word.placeholder, word.value])
  );
  return {
    filterExpression,
    expressionAttributeValues,
  };
}

function selectImage<Img extends { posted: number | undefined }>(
  images: Img[]
): Img | undefined {
  // TODO: Add some randomness to which eligible image is picked
  if (images.length <= 0) return;
  images.sort((a, b) => {
    if (a.posted === b.posted) return 0;
    if (!a.posted) return -1;
    if (!b.posted) return 1;
    return a.posted - b.posted;
  });
  return images[0];
}

async function postImage(imageUri: string, groupMeBotId: string) {
  // TODO: Post image to group
}

async function markAsPosted(groupId: string, fileId: string) {
  const dynamoDb = dynamoDbClient();
  const date = Date.now();

  await dynamoDb.update({
    Key: {
      groupId: groupId,
      fileId: fileId,
    },
    UpdateExpression: "SET posted = :p",
    ExpressionAttributeValues: {
      ":p": date,
    },
  });
}
