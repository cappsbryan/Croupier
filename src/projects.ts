import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { AttributeMap, BatchWriteItemOutput } from "aws-sdk/clients/dynamodb";

import { chunked } from "./utils";
import { Image } from "./models/Image";
import { Project } from "./models/Project";
import { badRequest, created, noContent, notFound, ok } from "./responses";
import { Convert, CreateProjectRequest } from "./dtos/CreateProjectRequest";
import { dynamoDbClient, ProjectTableClient } from "./dynamoDbClient";
import { Lambda } from "aws-sdk";

function projectResponse(project: AttributeMap | CreateProjectRequest) {
  const res = project as any;
  const { fileId, subject, ...response } = res;
  return response;
}

export async function getOne(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims.sub;
  if (event.pathParameters?.groupId === undefined)
    return badRequest("Missing id in path");
  if (!claimedSub) return badRequest("Not authorized");

  const dynamoDb = dynamoDbClient();
  const attributes = await dynamoDb.get({
    Key: {
      groupId: event.pathParameters.groupId,
      fileId: "!",
    },
  });

  const item = attributes.Item;
  if (!item || item.subject != claimedSub) return notFound();
  return ok(projectResponse(item));
}

export async function getMine(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims.sub;
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
  const claimedSub = event.requestContext.authorizer.jwt.claims.sub;
  if (!event.body) return badRequest("Missing request body");
  if (!claimedSub) return badRequest("Not authorized");

  let body: CreateProjectRequest;
  try {
    body = convertBody(event.body);
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
      return badRequest("A project with that groupId already exists");
    } else {
      throw e;
    }
  }

  const lambda = new Lambda();
  await lambda
    .invokeAsync({
      FunctionName: process.env.PROCESS_IMAGES_FUNCTION_NAME as string,
      InvokeArgs: JSON.stringify({ groupId: body.groupId }),
    })
    .promise();

  return created(body, "/projects/" + body.groupId);
}

export async function updateOne(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims.sub;
  if (event.pathParameters?.groupId === undefined)
    return badRequest("Missing id in path");
  if (!claimedSub || typeof claimedSub !== "string")
    return badRequest("Not authorized");
  if (!event.body) return badRequest("Missing request body");

  let body: CreateProjectRequest;
  try {
    body = convertBody(event.body);
  } catch (e: unknown) {
    if (e instanceof Error) return badRequest(e.message);
    else throw e;
  }

  if (event.pathParameters?.groupId !== body.groupId)
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
    if (result.Attributes?.folderId !== body.folderId) {
      const lambda = new Lambda();
      await lambda
        .invokeAsync({
          FunctionName: process.env.PROCESS_IMAGES_FUNCTION_NAME as string,
          InvokeArgs: JSON.stringify({
            groupId: body.groupId,
          }),
        })
        .promise();
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
  const claimedSub = event.requestContext.authorizer.jwt.claims.sub;
  if (event.pathParameters?.groupId === undefined)
    return badRequest("Missing id in path");
  if (!claimedSub) return badRequest("Not authorized");

  const groupId = event.pathParameters?.groupId;
  const dynamoDb = dynamoDbClient();
  let queryResult = await dynamoDb.fullQuery({
    KeyConditionExpression: "groupId = :g",
    ExpressionAttributeValues: { ":g": groupId },
  });
  const items = queryResult.Items as (Project | Image)[] | undefined;
  if (!items || items.length === 0) return notFound();

  const project = items[0];
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

function convertBody(requestBody: any): CreateProjectRequest {
  const body = Convert.toCreateProjectRequest(requestBody);
  body.keyword = body.keyword.toLowerCase();
  for (const [key, value] of Object.entries(body.replacements)) {
    body.replacements[key.toLowerCase()] = value.toLowerCase();
  }
  return body;
}
