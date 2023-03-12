import type { APIGatewayProxyResult } from "aws-lambda";

export function ok(item: any, location?: string): APIGatewayProxyResult {
  return {
    statusCode: 200,
    body: JSON.stringify(item),
    headers: {
      "Content-Type": "application/json",
      ...(location && { "Content-Location": location }),
    },
  };
}

export function created(item: any, location: string): APIGatewayProxyResult {
  return {
    statusCode: 201,
    body: JSON.stringify(item),
    headers: {
      "Content-Type": "application/json",
      "Content-Location": location,
    },
  };
}

export function noContent(): APIGatewayProxyResult {
  return {
    statusCode: 204,
    body: "",
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
