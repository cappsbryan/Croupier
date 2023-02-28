import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { EventBridge, Lambda } from "aws-sdk";
import { Convert, SetScheduleRequest } from "./dtos/SetScheduleRequest";
import { badRequest, internalServerError, notFound, ok } from "./responses";

export async function get(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims.sub;
  const groupId = event.pathParameters?.groupId;
  if (!groupId) return badRequest("Missing groupId in path");
  if (!claimedSub) return badRequest("Not authorized");
  if (!process.env.EVENT_RULE_NAME_PREFIX) return internalServerError();

  const ruleName = process.env.EVENT_RULE_NAME_PREFIX + groupId;
  const eventBridge = new EventBridge();
  const rule = await eventBridge.describeRule({ Name: ruleName }).promise();

  if (rule) {
    const schedule = rule.ScheduleExpression;
    if (!schedule || !schedule.startsWith("cron("))
      return internalServerError("Malformed schedule");
    const [minute, hour, ...rest] = schedule
      .substring(5, schedule.length - 1)
      .split(" ");
    return ok({ hour, minute });
  }
  return notFound("No schedule has been set yet");
}

export async function set(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims.sub;
  const groupId = event.pathParameters?.groupId;
  if (!groupId) return badRequest("Missing groupId in path");
  if (!event.body) return badRequest("Missing request body");
  if (!claimedSub) return badRequest("Not authorized");
  if (!process.env.EVENT_RULE_NAME_PREFIX) return internalServerError();
  if (!process.env.DAILY_MESSAGE_FUNCTION_ARN) return internalServerError();
  if (!process.env.DAILY_MESSAGE_FUNCTION_NAME) return internalServerError();

  console.log(
    "env:",
    process.env.EVENT_RULE_NAME_PREFIX,
    process.env.DAILY_MESSAGE_FUNCTION_ARN,
    process.env.DAILY_MESSAGE_FUNCTION_NAME
  );

  let request: SetScheduleRequest;
  try {
    request = Convert.toSetScheduleRequest(event.body);
  } catch (e) {
    return badRequest(e.message);
  }

  const ruleName = process.env.EVENT_RULE_NAME_PREFIX + groupId;
  const statementId = ruleName + "-permission";
  const eventBridge = new EventBridge();
  const rule = await eventBridge
    .putRule({
      Name: ruleName,
      ScheduleExpression: `cron(${request.minute} ${request.hour} * * ? *)`,
    })
    .promise();
  await eventBridge
    .putTargets({
      Rule: ruleName,
      Targets: [
        {
          Id: "dailyMessage",
          Arn: process.env.DAILY_MESSAGE_FUNCTION_ARN,
          Input: JSON.stringify({ groupId: groupId }),
        },
      ],
    })
    .promise();

  const lambda = new Lambda();
  const policyResponse = await lambda
    .getPolicy({ FunctionName: process.env.DAILY_MESSAGE_FUNCTION_NAME })
    .promise();
  const policy: { Statement: [{ Sid: string }] } = policyResponse.Policy
    ? JSON.parse(policyResponse.Policy)
    : undefined;

  if (!policy.Statement.find((statement) => statement.Sid === statementId)) {
    await lambda
      .addPermission({
        FunctionName: process.env.DAILY_MESSAGE_FUNCTION_NAME,
        StatementId: statementId,
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
        SourceArn: rule.RuleArn,
      })
      .promise();
  }

  return ok({
    hour: request.hour,
    minute: request.minute,
  });
}
