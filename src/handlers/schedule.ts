import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  EventBridge,
  DescribeRuleCommand,
  PutRuleCommand,
  PutTargetsCommand,
  DescribeRuleCommandOutput,
} from "@aws-sdk/client-eventbridge";
import {
  Lambda,
  AddPermissionCommand,
  GetPolicyCommand,
} from "@aws-sdk/client-lambda";

import { Convert, SetScheduleRequest } from "../dtos/SetScheduleRequest";
import { dynamoDbClient } from "../shared/dynamoDbClient";
import {
  badRequest,
  internalServerError,
  notFound,
  ok,
} from "../shared/responses";

export async function get(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims["sub"];
  const groupId = event.pathParameters?.["groupId"];
  const userEventRuleNamePrefix = process.env["USER_EVENT_RULE_NAME_PREFIX"];
  if (!groupId) return badRequest("Missing groupId in path");
  if (!claimedSub) return badRequest("Not authorized");
  if (!userEventRuleNamePrefix) return internalServerError();

  const dynamoDb = dynamoDbClient();
  const attributes = await dynamoDb.get({
    Key: {
      groupId: groupId,
      fileId: "!",
    },
  });

  const project = attributes.Item;
  if (!project || project["subject"] != claimedSub) return notFound();

  const ruleName = userEventRuleNamePrefix + groupId;
  const eventBridge = new EventBridge({});

  let rule: DescribeRuleCommandOutput | undefined;
  try {
    rule = await eventBridge.send(new DescribeRuleCommand({ Name: ruleName }));
  } catch {
    rule = undefined;
  }

  if (rule) {
    const schedule = rule.ScheduleExpression;
    if (!schedule || !schedule.startsWith("cron("))
      return internalServerError("Malformed schedule");
    const [minute, hour] = schedule
      .substring(5, schedule.length - 1)
      .split(" ");
    return ok({ hour, minute });
  }
  return notFound("No schedule has been set yet");
}

export async function set(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims["sub"];
  const groupId = event.pathParameters?.["groupId"];
  const userEventRuleNamePrefix = process.env["USER_EVENT_RULE_NAME_PREFIX"];
  const dailyMessageFunctionArn = process.env["DAILY_MESSAGE_FUNCTION_ARN"];
  const dailyMessageFunctionName = process.env["DAILY_MESSAGE_FUNCTION_NAME"];
  if (!groupId) return badRequest("Missing groupId in path");
  if (!event.body) return badRequest("Missing request body");
  if (!claimedSub) return badRequest("Not authorized");
  if (!userEventRuleNamePrefix) return internalServerError();
  if (!dailyMessageFunctionArn) return internalServerError();
  if (!dailyMessageFunctionName) return internalServerError();

  const dynamoDb = dynamoDbClient();
  const attributes = await dynamoDb.get({
    Key: {
      groupId: groupId,
      fileId: "!",
    },
  });

  const project = attributes.Item;
  if (!project || project["subject"] != claimedSub) return notFound();

  let request: SetScheduleRequest;
  try {
    request = Convert.toSetScheduleRequest(event.body);
  } catch (e) {
    if (e instanceof Error) return badRequest(e.message);
    else return badRequest();
  }

  const ruleName = userEventRuleNamePrefix + groupId;
  const statementId = ruleName + "-permission";
  const eventBridge = new EventBridge({});
  const rule = await eventBridge.send(
    new PutRuleCommand({
      Name: ruleName,
      ScheduleExpression: `cron(${request.minute} ${request.hour} * * ? *)`,
    })
  );
  await eventBridge.send(
    new PutTargetsCommand({
      Rule: ruleName,
      Targets: [
        {
          Id: "dailyMessage",
          Arn: dailyMessageFunctionArn,
          Input: JSON.stringify({ groupId: groupId }),
        },
      ],
    })
  );

  const lambda = new Lambda({});
  let hasPolicyStatement: boolean;
  try {
    const policyResponse = await lambda.send(
      new GetPolicyCommand({
        FunctionName: dailyMessageFunctionName,
      })
    );
    const policy: { Statement: [{ Sid: string }] } = policyResponse.Policy
      ? JSON.parse(policyResponse.Policy)
      : undefined;
    hasPolicyStatement = policy.Statement.some(
      (statement) => statement.Sid === statementId
    );
  } catch {
    hasPolicyStatement = false;
  }

  if (!hasPolicyStatement) {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: dailyMessageFunctionName,
        StatementId: statementId,
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
        SourceArn: rule.RuleArn,
      })
    );
  }

  return ok({
    hour: request.hour,
    minute: request.minute,
  });
}
