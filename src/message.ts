import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

import { Readable } from "stream";
import { ReadableStream } from "stream/web";
import { driveClient } from "./driveClient";

import { Convert, GroupMeCallback } from "./dtos/GroupMeCallback";
import { dynamoDbClient } from "./dynamoDbClient";
import { Image } from "./models/Image";
import { Project } from "./models/Project";
import { badRequest, internalServerError, ok } from "./responses";
import { groupmeAccessToken } from "./secrets";

export async function dailyMessage(event: { groupId: string }) {
  const project = await getProject(event.groupId);
  if (!project)
    return internalServerError(
      `Failed to retrieve project associated with group: ${event.groupId}`
    );

  const eligibleImages = await searchForImages(undefined, project);
  console.info("found %d eligible images", eligibleImages.length);
  const image = selectImage(eligibleImages);
  if (!image)
    return ok({
      groupId: event.groupId,
      image: null,
    });
  console.info("posting file id:", image.fileId);

  let uri = image.uri;
  if (!uri) {
    const imageData = await downloadImage(image.fileId);
    uri = await uploadImage(image.fileId, imageData.stream, imageData.mimeType);
  }
  if (!uri) return internalServerError("Failed to upload image");
  console.info("groupme image url:", uri);

  await postImage(uri, project.botId, project.emojis);
  await markAsPosted(project.groupId, image.fileId, uri);

  return ok({
    groupId: event.groupId,
    fileId: image.fileId,
    uri: image.uri,
  });
}

export async function receiveMessage(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!event.body) return badRequest();

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
  console.info("received search:", search);
  const eligibleImages = await searchForImages(search, project);
  console.info("found %d eligible images", eligibleImages.length);
  const image = selectImage(eligibleImages);
  if (!image)
    return ok({
      groupId: groupMeCallback.group_id,
      image: null,
    });
  console.info("posting file id:", image.fileId);

  let uri = image.uri;
  if (!uri) {
    const imageData = await downloadImage(image.fileId);
    uri = await uploadImage(image.fileId, imageData.stream, imageData.mimeType);
  }
  if (!uri) return internalServerError("Failed to upload image");
  console.info("groupme image url:", uri);

  await postImage(uri, project.botId, project.emojis);
  await markAsPosted(project.groupId, image.fileId, uri);

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
  "emojis",
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
    KeyConditionExpression: "groupId = :g AND fileId > :f",
    ExpressionAttributeValues: {
      ":g": project.groupId,
      ":f": "!",
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

function selectImage<Img extends Pick<Image, "posted">>(
  images: Img[]
): Img | undefined {
  // TODO: Add some randomness to which eligible image is picked
  if (images.length <= 0) return;

  const weightedIndices = images.flatMap((image, index): number[] => {
    if (image.posted) {
      const delta = Date.now() - image.posted;
      const days = Math.max(60, delta / 86_400_000);
      const count = Math.ceil(days ** 2 / 35);
      return Array(count).fill(index);
    } else {
      return Array(300).fill(index);
    }
  });

  const randomIndex = Math.floor(Math.random() * weightedIndices.length);
  return images[weightedIndices[randomIndex]];
}

async function downloadImage(
  fileId: string
): Promise<{ stream: ReadableStream; mimeType: string }> {
  const drive = await driveClient();

  console.log(`Downloading file ${fileId}...`);
  const driveResponse = await drive.files.get(
    {
      fileId: fileId,
      alt: "media",
    },
    { responseType: "stream" }
  );
  const mimeType = driveResponse.headers["content-type"];
  const stream = Readable.toWeb(driveResponse.data);
  return { stream, mimeType };
}

async function uploadImage(
  fileId: string,
  stream: ReadableStream,
  mimeType: string
): Promise<string | undefined> {
  console.log(`Uploading file ${fileId}...`);
  const info: RequestInit & { duplex: "half" } = {
    body: stream as any, // some sort of TypeScript bug? ReadableStream != ReadableStream
    duplex: "half", // duplex is required if body is a stream, but TypeScript doesn't know it
    method: "post",
    headers: {
      "X-Access-Token": await groupmeAccessToken(),
      "Content-Type": mimeType,
    },
  };
  const uploadResponse = await fetch(
    "https://image.groupme.com/pictures",
    info
  );
  const uploadResponseBody = await uploadResponse.json();
  const imageUrl: string | undefined = uploadResponseBody?.payload?.url;
  if (!imageUrl) {
    console.warn("upload response:", uploadResponseBody);
    console.warn("upload response headers:");
    uploadResponse.headers.forEach((value, key) => {
      console.warn(`${key}: ${value}`);
    });
  }
  return imageUrl;
}

async function postImage(
  imageUri: string,
  groupMeBotId: string,
  emojis: string[]
) {
  const emoji = emojis[getRandomInt(emojis.length)];
  await fetch("https://api.groupme.com/v3/bots/post", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bot_id: groupMeBotId,
      text: `Here's a picture ${emoji}`,
      attachments: [
        {
          type: "image",
          url: imageUri,
        },
      ],
    }),
  });
}

function getRandomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

async function markAsPosted(groupId: string, fileId: string, uri: string) {
  const dynamoDb = dynamoDbClient();
  const date = Date.now();

  await dynamoDb.update({
    Key: {
      groupId: groupId,
      fileId: fileId,
    },
    UpdateExpression: "SET posted=:p, uri=:u",
    ExpressionAttributeValues: {
      ":p": date,
      ":u": uri,
    },
  });
}
