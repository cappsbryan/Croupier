import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { AttributeMap } from "aws-sdk/clients/dynamodb";

import { badRequest, created, notFound, ok } from "./responses";
import { Convert, CreateProjectRequest } from "./dtos/CreateProjectRequest";
import { dynamoDbClient } from "./dynamoDbClient";

function projectResponse(project: AttributeMap) {
  const { fileId, subject, ...response } = project;
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
    body = Convert.toCreateProjectRequest(event.body);
  } catch (e: unknown) {
    if (e instanceof Error) return badRequest(e.message);
    else throw e;
  }
  body.keyword = body.keyword.toLowerCase();

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

  return created(body);
}
