import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { DynamoDB } from "aws-sdk";
import {
  badRequest,
  created,
  internalServerError,
  notFound,
  ok,
} from "./responses";
import { Convert, CreateProjectRequest } from "./dtos/CreateProjectRequest";

export async function getOne(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims.sub;
  if (!process.env.DYNAMODB_PROJECT_TABLE)
    return internalServerError("Failed to connect to database");
  if (event.pathParameters?.groupme_group_id === undefined)
    return badRequest("Missing id in path");
  if (!claimedSub) return badRequest("Not authorized");

  const dynamoDb = new DynamoDB.DocumentClient();
  const attributes = await dynamoDb
    .get({
      TableName: process.env.DYNAMODB_PROJECT_TABLE,
      Key: {
        groupme_group_id: event.pathParameters.groupme_group_id,
        file_id: "project",
      },
    })
    .promise();

  const item = attributes.Item;
  if (!item || item.sub != claimedSub) return notFound();
  const { file_id, sub, ...response } = item;
  return ok(response);
}

export async function create(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims.sub;
  if (!process.env.DYNAMODB_PROJECT_TABLE)
    return internalServerError("Failed to connect to database");
  if (!event.body) return badRequest("Missing request body");
  if (!claimedSub) return badRequest("Not authorized");

  let body: CreateProjectRequest;
  try {
    body = Convert.toCreateProjectRequest(event.body);
  } catch (e: unknown) {
    if (e instanceof Error) return badRequest(e.message);
    else throw e;
  }

  const dynamoDb = new DynamoDB.DocumentClient();
  const putParams = {
    TableName: process.env.DYNAMODB_PROJECT_TABLE,
    Item: {
      file_id: "project",
      sub: claimedSub,
      ...body,
    },
    ConditionExpression: "attribute_not_exists(groupme_group_id)",
  };
  try {
    await dynamoDb.put(putParams).promise();
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "ConditionalCheckFailedException") {
      return badRequest("A project with that groupme_group_id already exists");
    } else {
      throw e;
    }
  }

  return created(body);
}
