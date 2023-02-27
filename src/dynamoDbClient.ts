import { AWSError, Request } from "aws-sdk";
import { DocumentClient } from "aws-sdk/clients/dynamodb";
import { chunked } from "./utils";

type OmitTableName<T> = Omit<T, "TableName">;

let cachedDynamoDbClient: ProjectTableClient | undefined;

export class ProjectTableClient {
  private tableName: string;
  private documentClient: DocumentClient;

  constructor(tableName: string) {
    this.tableName = tableName;
    this.documentClient = new DocumentClient();
  }

  get(
    params: ProjectTableClient.GetItemInput
  ): Promise<DocumentClient.GetItemOutput> {
    return this.documentClient
      .get({
        ...params,
        TableName: this.tableName,
      })
      .promise();
  }

  put(
    params: ProjectTableClient.PutItemInput
  ): Promise<DocumentClient.PutItemOutput> {
    return this.documentClient
      .put({
        ...params,
        TableName: this.tableName,
      })
      .promise();
  }

  update(
    params: ProjectTableClient.UpdateItemInput
  ): Promise<DocumentClient.UpdateItemOutput> {
    return this.documentClient
      .update({
        ...params,
        TableName: this.tableName,
      })
      .promise();
  }

  delete(
    params: ProjectTableClient.DeleteItemInput
  ): Promise<DocumentClient.DeleteItemOutput> {
    return this.documentClient
      .delete({
        ...params,
        TableName: this.tableName,
      })
      .promise();
  }

  async batchWrite(
    params: ProjectTableClient.BatchWriteItemInput
  ): Promise<DocumentClient.BatchWriteItemOutput[]> {
    const { RequestItems, ...otherParams } = params;

    let calls: Promise<DocumentClient.BatchWriteItemOutput>[] = [];
    const chunkedItems = chunked(RequestItems);
    for (const chunk of chunkedItems) {
      const batchWriteCall = this.retryingBatchWrite({
        RequestItems: chunk,
        ...otherParams,
      });
      calls.push(batchWriteCall);
    }

    return await Promise.all(calls);
  }

  private async retryingBatchWrite(
    params: ProjectTableClient.BatchWriteItemInput
  ): Promise<DocumentClient.BatchWriteItemOutput> {
    const { RequestItems, ...otherParams } = params;
    const docParams = {
      RequestItems: {
        [this.tableName]: RequestItems,
      },
      ...otherParams,
    };

    let result = await this.documentClient.batchWrite(docParams).promise();
    let unprocessed = result.UnprocessedItems;
    let backoff = 0.5;
    while (unprocessed && Object.keys(unprocessed).length > 0 && backoff < 64) {
      backoff = backoff * 2;
      const unprocessedCount = Object.values(unprocessed).reduce(
        (res, items) => res + items.length,
        0
      );
      console.info(
        `Retrying batch write after ${backoff} seconds`,
        `${unprocessedCount} unprocessed items`
      );
      await sleep((backoff + Math.random()) * 1000);
      result = await this.documentClient
        .batchWrite({
          RequestItems: unprocessed,
          ...otherParams,
        })
        .promise();
      unprocessed = result.UnprocessedItems;
    }

    if (unprocessed && Object.keys(unprocessed).length > 0) {
      console.warn("Batch write failed");
    }

    return result;
  }

  query(
    params: ProjectTableClient.QueryInput
  ): Promise<DocumentClient.QueryOutput> {
    return this.documentClient
      .query({
        ...params,
        TableName: this.tableName,
      })
      .promise();
  }

  async fullQuery(
    params: ProjectTableClient.QueryInput
  ): Promise<ProjectTableClient.FullQueryOutput> {
    let mergedResults = (await this.query(
      params
    )) as ProjectTableClient.FullQueryOutput;

    // handle paginated responses
    while (mergedResults.LastEvaluatedKey) {
      const nextResult = await this.query({
        ...params,
        ExclusiveStartKey: mergedResults.LastEvaluatedKey,
      });

      mergedResults.LastEvaluatedKey = nextResult.LastEvaluatedKey;
      mergedResults.Count =
        mergedResults.Count && nextResult.Count
          ? mergedResults.Count + nextResult.Count
          : undefined;
      mergedResults.ScannedCount =
        mergedResults.ScannedCount && nextResult.ScannedCount
          ? mergedResults.ScannedCount + nextResult.ScannedCount
          : undefined;
      mergedResults.Items =
        mergedResults.Items && nextResult.Items
          ? mergedResults.Items.concat(nextResult.Items)
          : undefined;
    }
    return mergedResults;
  }
}

export namespace ProjectTableClient {
  export type GetItemInput = OmitTableName<DocumentClient.GetItemInput>;
  export type PutItemInput = OmitTableName<DocumentClient.PutItemInput>;
  export type UpdateItemInput = OmitTableName<DocumentClient.UpdateItemInput>;
  export type DeleteItemInput = OmitTableName<DocumentClient.DeleteItemInput>;
  export type BatchWriteItemInput = Omit<
    DocumentClient.BatchWriteItemInput,
    "RequestItems"
  > & { RequestItems: DocumentClient.WriteRequests };
  export type QueryInput = OmitTableName<DocumentClient.QueryInput>;
  export type FullQueryOutput = Omit<
    DocumentClient.QueryOutput,
    "ConsumedCapacity"
  >;
}

export function dynamoDbClient(): ProjectTableClient {
  if (cachedDynamoDbClient) return cachedDynamoDbClient;
  return new ProjectTableClient(process.env.DYNAMODB_PROJECT_TABLE as string);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
