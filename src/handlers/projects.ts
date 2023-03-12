import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { Lambda } from "@aws-sdk/client-lambda";

import type { Image } from "../models/Image";
import type { Project } from "../models/Project";
import {
  badRequest,
  created,
  noContent,
  notFound,
  ok,
} from "../shared/responses";
import { Convert, CreateProjectRequest } from "../dtos/CreateProjectRequest";
import { dynamoDbClient } from "../shared/dynamoDbClient";
import { uploadImage } from "../shared/images";

function projectResponse(project: Record<string, any>) {
  const { fileId, subject, ...response } = project;
  return response;
}

export async function getOne(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims["sub"];
  const groupId = event.pathParameters?.["groupId"];
  if (!groupId) return badRequest("Missing id in path");
  if (!claimedSub) return badRequest("Not authorized");

  const dynamoDb = dynamoDbClient();
  const attributes = await dynamoDb.get({
    Key: {
      groupId: groupId,
      fileId: "!",
    },
  });

  const item = attributes.Item;
  if (!item || item["subject"] != claimedSub) return notFound();
  return ok(projectResponse(item));
}

export async function getMine(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims["sub"];
  if (!claimedSub) return badRequest("Not authorized");

  const dynamoDb = dynamoDbClient();
  const attributes = await dynamoDb.query({
    IndexName: "subjectIndex",
    KeyConditionExpression: "subject = :subject",
    ExpressionAttributeValues: {
      ":subject": claimedSub,
    },
  });

  const items = attributes.Items;
  if (!items) return notFound();
  return ok(items.map((item) => projectResponse(item)));
}

export async function create(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims["sub"];
  if (!event.body) return badRequest("Missing request body");
  if (!claimedSub) return badRequest("Not authorized");

  let body: CreateProjectRequest;
  try {
    body = await convertBody(event.body);
  } catch (e: unknown) {
    if (e instanceof Error) return badRequest(e.message);
    else throw e;
  }

  const dynamoDb = dynamoDbClient();
  const putParams = {
    Item: {
      fileId: "!", // constant indicating this item represents the project, not a file
      subject: claimedSub,
      ...body,
    },
    ConditionExpression: "attribute_not_exists(groupId)",
  };
  try {
    await dynamoDb.put(putParams);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "ConditionalCheckFailedException") {
      console.error("A project with that groupId already exists");
      return badRequest();
    } else {
      throw e;
    }
  }

  const lambda = new Lambda({});
  await lambda.invoke({
    FunctionName: process.env["PROCESS_IMAGES_FUNCTION_NAME"],
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify({ groupId: body.groupId })),
  });
  console.info(
    "Invoked",
    process.env["PROCESS_IMAGES_FUNCTION_NAME"],
    body.groupId
  );

  return created(body, "/projects/" + body.groupId);
}

export async function updateOne(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims["sub"];
  if (event.pathParameters?.["groupId"] === undefined)
    return badRequest("Missing id in path");
  if (!claimedSub || typeof claimedSub !== "string")
    return badRequest("Not authorized");
  if (!event.body) return badRequest("Missing request body");

  let body: CreateProjectRequest;
  try {
    body = await convertBody(event.body);
  } catch (e: unknown) {
    if (e instanceof Error) return badRequest(e.message);
    else throw e;
  }

  if (event.pathParameters?.["groupId"] !== body.groupId)
    return badRequest("groupId doesn't match url path");

  const dynamoDb = dynamoDbClient();
  const project: Project = {
    fileId: "!", // constant indicating this item represents the project, not a file
    subject: claimedSub,
    ...body,
  };
  try {
    const result = await dynamoDb.put({
      Item: project,
      ConditionExpression: "attribute_not_exists(groupId) OR subject = :s",
      ExpressionAttributeValues: {
        ":s": claimedSub,
      },
      ReturnValues: "ALL_OLD",
    });
    if (result.Attributes?.["folderId"] !== body.folderId) {
      const lambda = new Lambda({});
      await lambda.invoke({
        FunctionName: process.env["PROCESS_IMAGES_FUNCTION_NAME"] as string,
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            groupId: body.groupId,
          })
        ),
      });
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "ConditionalCheckFailedException") {
      return badRequest("You do not have permission to modify this project");
    } else {
      throw e;
    }
  }

  return ok(projectResponse(body), "/projects/" + body.groupId);
}

export async function deleteOne(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims["sub"];
  if (event.pathParameters?.["groupId"] === undefined)
    return badRequest("Missing id in path");
  if (!claimedSub) return badRequest("Not authorized");

  const groupId = event.pathParameters?.["groupId"];
  const dynamoDb = dynamoDbClient();
  let queryResult = await dynamoDb.fullQuery({
    KeyConditionExpression: "groupId = :g",
    ExpressionAttributeValues: { ":g": groupId },
  });
  const items = queryResult.Items as (Project | Image)[] | undefined;
  if (!items) return notFound();

  const project = items[0];
  if (!project) return notFound();
  if ("subject" in project && project.subject !== claimedSub) return notFound();

  await dynamoDb.batchWrite({
    RequestItems: items.map((item) => ({
      DeleteRequest: {
        Key: {
          groupId: groupId,
          fileId: item.fileId,
        },
      },
    })),
  });

  return noContent();
}

async function convertBody(requestBody: any): Promise<CreateProjectRequest> {
  const body = Convert.toCreateProjectRequest(requestBody);
  body.keyword = body.keyword.toLowerCase();
  for (const [key, value] of Object.entries(body.replacements)) {
    body.replacements[key.toLowerCase()] = value.toLowerCase();
  }
  const groupMeImageRegex = /^https\:\/\/i\.groupme\.com\/[\d]+x[\d]+\..+\..+$/;
  if (!groupMeImageRegex.test(body.notFoundLink)) {
    const converedNotFoundLink = await convertNotFoundLink(body.notFoundLink);
    body.notFoundLink = converedNotFoundLink;
  }
  return body;
}

async function convertNotFoundLink(link: string): Promise<string> {
  console.log("Fetching not found image:", link);
  const downloaded = await fetch(link);
  const contentType = downloaded.headers.get("content-type");
  console.log("Downloaded not found image with content type:", contentType);
  if (!contentType || !downloaded.body)
    throw new Error(
      "Unable to process notFoundLink. Consider using GroupMe's image service."
    );
  return await uploadImage(downloaded.body, contentType);
}
