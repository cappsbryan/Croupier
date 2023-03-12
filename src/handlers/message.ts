import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

import { Readable } from "stream";
import type { ReadableStream } from "stream/web";

import { driveClient } from "../shared/driveClient";
import { Convert, GroupMeCallback } from "../dtos/GroupMeCallback";
import { dynamoDbClient } from "../shared/dynamoDbClient";
import type { Image } from "../models/Image";
import type { Project } from "../models/Project";
import { badRequest, internalServerError, ok } from "../shared/responses";
import { uploadImage } from "../shared/images";

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
    console.log(`Uploading file ${image.fileId}...`);
    try {
      uri = await uploadImage(imageData.stream, imageData.mimeType);
    } catch {
      return internalServerError("Failed to upload image");
    }
  }
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
    if (e instanceof Error) return badRequest(e.message);
    else return internalServerError("Error parsing request body");
  }

  const project = await getProject(groupMeCallback.group_id);
  if (!project)
    return internalServerError(
      `Failed to retrieve project associated with group: ${groupMeCallback.group_id}`
    );

  if (groupMeCallback.sender_type === "bot") {
    return ok({
      groupId: groupMeCallback.group_id,
      message: `Ignored message from bot: ${groupMeCallback.name}`,
    });
  }

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

  if (eligibleImages.length === 0) {
    await postNotFoundMessage(project);
    return ok({
      groupId: groupMeCallback.group_id,
      message: "Posted image not found message",
    });
  }

  const image = selectImage(eligibleImages);
  if (!image) {
    console.warn("not posting, no image found");
    return ok({
      groupId: groupMeCallback.group_id,
      image: null,
    });
  }
  console.info("posting file id:", image.fileId);

  let uri = image.uri;
  if (!uri) {
    const imageData = await downloadImage(image.fileId);
    console.log(`Uploading file ${image.fileId}...`);
    try {
      uri = await uploadImage(imageData.stream, imageData.mimeType);
    } catch {
      return internalServerError("Failed to upload image");
    }
  }
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
  "notFoundMessage",
  "notFoundLink",
] satisfies (keyof Project)[];

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
  return words[0]?.toLowerCase() === word;
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

  // find each replacement key, but only matching whole words, then replace
  const orderedReplacementKeys = Object.keys(replacements).sort(
    (a, b) => b.length - a.length
  );
  for (const key of orderedReplacementKeys) {
    const index = search.indexOf(key);
    if (index === -1) continue;
    if (
      index + key.length !== search.length &&
      search[index + key.length + 1] !== " "
    )
      continue;
    search =
      search.slice(0, index) +
      replacements[key] +
      search.slice(index + key.length);
  }
  const searchWords = search.split(" ");

  const filter = searchWords.map((word, index) => ({
    placeholder: `:${index}`,
    value: word,
  }));

  const filterExpression = filter
    .map((f) => `contains(fname, ${f.placeholder})`)
    .join(" AND ");
  const expressionAttributeValues = Object.fromEntries(
    filter.map((f) => [f.placeholder, f.value])
  );
  return {
    filterExpression,
    expressionAttributeValues,
  };
}

function selectImage<Img extends Pick<Image, "posted">>(
  images: Img[]
): Img | undefined {
  if (images.length <= 0) return undefined;

  const weightedIndices = images.flatMap((image, index): number[] => {
    if (image.posted) {
      const delta = Date.now() - image.posted;
      const days = Math.min(60, delta / 86_400_000);
      const count = Math.ceil(days ** 2 / 35);
      return Array(count).fill(index);
    } else {
      return Array(300).fill(index);
    }
  });

  const randomWeightedIndex = Math.floor(
    Math.random() * weightedIndices.length
  );
  const randomIndex = weightedIndices[randomWeightedIndex];
  if (randomIndex === undefined) {
    console.error("Failed to get a random image index???");
    return undefined;
  }
  return images[randomIndex];
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

async function postNotFoundMessage(
  project: Pick<Project, "botId" | "notFoundMessage" | "notFoundLink">
) {
  await fetch("https://api.groupme.com/v3/bots/post", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bot_id: project.botId,
      text: project.notFoundMessage,
      attachments: [
        {
          type: "image",
          url: project.notFoundLink,
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
