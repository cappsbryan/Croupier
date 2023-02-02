import { APIGatewayProxyResult } from "aws-lambda";

export function ok(item: any): APIGatewayProxyResult {
  return {
    statusCode: 200,
    body: JSON.stringify(item),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

export function created(item: any): APIGatewayProxyResult {
  return {
    statusCode: 201,
    body: JSON.stringify(item),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

export function badRequest(message?: string): APIGatewayProxyResult {
  return {
    statusCode: 400,
    body: JSON.stringify({
      message: message || "Bad Request",
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

export function notFound(message?: string): APIGatewayProxyResult {
  return {
    statusCode: 404,
    body: JSON.stringify({
      message: message || "Not Found",
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

export function internalServerError(message?: string): APIGatewayProxyResult {
  return {
    statusCode: 500,
    body: JSON.stringify({
      message: message || "Internal Server Error",
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}
