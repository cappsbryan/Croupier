import { AWSError, Request } from "aws-sdk";
import { DocumentClient } from "aws-sdk/clients/dynamodb";

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
