import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import {
  RedstonePayload,
  UniversalSigner,
  consts,
  recoverDeserializedSignerAddress,
} from "@redstone-finance/protocol";
import {
  DataPackagesRequestParams,
  getDataServiceIdForSigner,
  parseDataPackagesResponse,
} from "@redstone-finance/sdk";
import { RedstoneCommon } from "@redstone-finance/utils";
import { DataPackagesBroadcaster } from "../broadcasters/data-packages-broadcaster";
import { MongoBroadcaster } from "../broadcasters/mongo-broadcaster";
import { StreamrBroadcaster } from "../broadcasters/streamr-broadcaster";
import config from "../config";
import { getOracleState } from "../utils/get-oracle-state";
import { makePayload } from "../utils/make-redstone-payload";
import {
  BulkPostRequestBody,
  DataPackagesResponse,
  DataPackagesStatsResponse,
  ReceivedDataPackage,
} from "./data-packages.interface";
import {
  CachedDataPackage,
  DataPackage,
  DataPackageDocumentAggregated,
  DataPackageDocumentMostRecentAggregated,
} from "./data-packages.model";
import { EMPTY_DATA_PACKAGE_RESPONSE_ERROR_CODE } from "../common/errors";

export interface StatsRequestParams {
  fromTimestamp: number;
  toTimestamp: number;
}

@Injectable()
export class DataPackagesService {
  private readonly logger = new Logger(DataPackagesService.name);
  private readonly broadcasters: DataPackagesBroadcaster[] = [];

  constructor(
    @Optional() private readonly mongoBroadcaster?: MongoBroadcaster,
    @Optional() private readonly streamrBroadcaster?: StreamrBroadcaster
  ) {
    if (mongoBroadcaster) {
      this.broadcasters.push(mongoBroadcaster);
    }
    if (streamrBroadcaster) {
      this.broadcasters.push(streamrBroadcaster);
    }

    this.logger.log(
      `Active broadcasters:  ${this.broadcasters
        .map((broadcaster) => broadcaster.constructor.name)
        .join(",")}`
    );
  }

  /**  Save dataPackages to DB and streamr (optionally) */
  async broadcast(
    dataPackagesToSave: CachedDataPackage[],
    nodeEvmAddress: string
  ): Promise<void> {
    const savePromises: Promise<unknown>[] = this.broadcasters.map(
      (broadcaster) => broadcaster.broadcast(dataPackagesToSave, nodeEvmAddress)
    );

    await Promise.allSettled(savePromises);
  }

  getLatestDataPackagesWithSameTimestampWithCache = RedstoneCommon.memoize({
    functionToMemoize: (dataServiceId: string) =>
      this.getLatestDataPackagesFromDbWithSameTimestamp(dataServiceId),
    ttl: config.dataPackagesTTL,
  });

  getLatestDataPackagesWithCache = RedstoneCommon.memoize({
    functionToMemoize: (dataServiceId: string) =>
      DataPackagesService.getDataPackagesFromDbByTimestampOrLatest(
        dataServiceId
      ),
    ttl: config.dataPackagesTTL,
  });

  static async getDataPackagesByTimestamp(
    dataServiceId: string,
    timestamp: number
  ): Promise<DataPackagesResponse> {
    return await DataPackagesService.getDataPackagesFromDbByTimestampOrLatest(
      dataServiceId,
      timestamp
    );
  }

  static async isDataServiceIdValid(dataServiceId: string): Promise<boolean> {
    const oracleRegistryState = await getOracleState();
    return !!oracleRegistryState.dataServices[dataServiceId];
  }

  /**
   * Packages might have different timestamps if timestamp not passed
   * */
  static async getDataPackagesFromDbByTimestampOrLatest(
    dataServiceId: string,
    timestamp?: number
  ): Promise<DataPackagesResponse> {
    const fetchedPackagesPerDataFeed: DataPackagesResponse = {};

    const groupedDataPackages =
      await DataPackage.aggregate<DataPackageDocumentMostRecentAggregated>([
        {
          $match: {
            dataServiceId,
            timestampMilliseconds: timestamp
              ? new Date(timestamp)
              : {
                  $gte: new Date(Date.now() - config.maxAllowedTimestampDelay),
                },
          },
        },
        {
          $group: {
            _id: {
              signerAddress: "$signerAddress",
              dataFeedId: "$dataFeedId",
            },
            timestampMilliseconds: { $first: "$timestampMilliseconds" },
            signature: { $first: "$signature" },
            dataPoints: { $first: "$dataPoints" },
            dataServiceId: { $first: "$dataServiceId" },
            dataFeedId: { $first: "$dataFeedId" },
            isSignatureValid: { $first: "$isSignatureValid" },
          },
        },
        {
          $sort: { timestampMilliseconds: -1 },
        },
      ]);

    if (groupedDataPackages.length === 0) {
      throw new HttpException(
        "Data packages response is empty",
        EMPTY_DATA_PACKAGE_RESPONSE_ERROR_CODE
      );
    }

    // Parse DB response
    for (const dataPackage of groupedDataPackages) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { _id, ...rest } = dataPackage;
      const dataFeedId = _id.dataFeedId;
      if (!fetchedPackagesPerDataFeed[dataFeedId]) {
        fetchedPackagesPerDataFeed[dataFeedId] = [];
      }

      fetchedPackagesPerDataFeed[dataFeedId]!.push({
        ...rest,
        timestampMilliseconds: rest.timestampMilliseconds.getTime(),
        dataFeedId,
        signerAddress: _id.signerAddress,
      });
    }

    return fetchedPackagesPerDataFeed;
  }

  /**
   * All packages will share common timestamp
   *  */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async getLatestDataPackagesFromDbWithSameTimestamp(
    dataServiceId: string
  ): Promise<DataPackagesResponse> {
    const fetchedPackagesPerDataFeed: DataPackagesResponse = {};

    const groupedDataPackages =
      await DataPackage.aggregate<DataPackageDocumentAggregated>([
        {
          $match: {
            dataServiceId,
            timestampMilliseconds: {
              $gte: new Date(Date.now() - config.maxAllowedTimestampDelay),
            },
          },
        },
        {
          $group: {
            _id: {
              timestampMilliseconds: "$timestampMilliseconds",
            },
            count: { $count: {} },
            signatures: { $push: "$signature" },
            dataPoints: { $push: "$dataPoints" },
            dataFeedIds: { $push: "$dataFeedId" },
            signerAddress: { $push: "$signerAddress" },
            isSignatureValid: { $push: "$isSignatureValid" },
          },
        },
        {
          $sort: { count: -1, "_id.timestampMilliseconds": -1 },
        },
        {
          $limit: 1,
        },
      ]);

    if (groupedDataPackages.length === 0) {
      throw new HttpException(
        "Data packages response is empty",
        EMPTY_DATA_PACKAGE_RESPONSE_ERROR_CODE
      );
    }

    // Parse DB response
    const dataPackagesWithSameTimestamp = groupedDataPackages[0];
    for (let i = 0; i < dataPackagesWithSameTimestamp.count; i++) {
      const dataFeedId = dataPackagesWithSameTimestamp.dataFeedIds[i];
      const signerAddress = dataPackagesWithSameTimestamp.signerAddress[i];
      if (
        DataPackagesService.isSignerAddressAlreadyInDbResponseForDataFeed(
          signerAddress,
          fetchedPackagesPerDataFeed[dataFeedId]
        )
      ) {
        continue;
      }
      const dataPoints = dataPackagesWithSameTimestamp.dataPoints[i];
      const signature = dataPackagesWithSameTimestamp.signatures[i];
      const timestampMilliseconds =
        dataPackagesWithSameTimestamp._id.timestampMilliseconds.getTime();
      const isSignatureValid =
        dataPackagesWithSameTimestamp.isSignatureValid[i];

      if (!fetchedPackagesPerDataFeed[dataFeedId]) {
        fetchedPackagesPerDataFeed[dataFeedId] = [];
      }

      fetchedPackagesPerDataFeed[dataFeedId]!.push({
        timestampMilliseconds,
        signature,
        isSignatureValid,
        dataPoints,
        dataServiceId,
        dataFeedId,
        signerAddress,
      });
    }

    return fetchedPackagesPerDataFeed;
  }

  // Filtering unique signers addresses
  static isSignerAddressAlreadyInDbResponseForDataFeed(
    signerAddress: string,
    fetchedPackagesForDataFeed: CachedDataPackage[] | undefined
  ): boolean {
    return (
      !!fetchedPackagesForDataFeed &&
      fetchedPackagesForDataFeed.some(
        (dataPackage) => dataPackage.signerAddress === signerAddress
      )
    );
  }

  async queryLatestDataPackages(requestParams: DataPackagesRequestParams) {
    const cachedDataPackagesResponse =
      await this.getLatestDataPackagesWithSameTimestampWithCache(
        requestParams.dataServiceId
      );

    return parseDataPackagesResponse(cachedDataPackagesResponse, requestParams);
  }

  async getPayload(
    requestParams: DataPackagesRequestParams
  ): Promise<RedstonePayload> {
    const cachedDataPackagesResponse =
      await this.getLatestDataPackagesWithCache(requestParams.dataServiceId);

    const dataPackages = parseDataPackagesResponse(
      cachedDataPackagesResponse,
      requestParams
    );

    return makePayload(dataPackages);
  }

  static async getDataPackagesStats(
    statsRequestParams: StatsRequestParams
  ): Promise<DataPackagesStatsResponse> {
    const { fromTimestamp, toTimestamp } = statsRequestParams;

    if (toTimestamp - fromTimestamp > 7_200_000) {
      throw new BadRequestException(
        "Too big search period. Can not be bigger than 7_200_000"
      );
    }

    const oraclesState = await getOracleState();
    const nodes = Object.values(oraclesState.nodes);

    const countsPerNode = await Promise.all(
      nodes.map(async (node) => {
        const count = await DataPackage.countDocuments({
          $and: [
            { timestampMilliseconds: { $gte: new Date(fromTimestamp) } },
            { timestampMilliseconds: { $lte: new Date(toTimestamp) } },
            { dataServiceId: node.dataServiceId },
            { signerAddress: node.evmAddress },
            { isSignatureValid: true },
          ],
        });
        return { node, count };
      })
    );

    const stats: DataPackagesStatsResponse = {};

    for (const countPerNode of countsPerNode) {
      stats[countPerNode.node.evmAddress] = {
        dataServiceId: countPerNode.node.dataServiceId,
        verifiedDataPackagesCount: countPerNode.count,
        nodeName: countPerNode.node.name,
      };
    }

    return stats;
  }

  static verifyRequester(body: BulkPostRequestBody) {
    return UniversalSigner.recoverSigner(
      body.dataPackages,
      body.requestSignature
    );
  }

  static async prepareReceivedDataPackagesForBulkSaving(
    receivedDataPackages: ReceivedDataPackage[],
    signerAddress: string
  ) {
    const oracleRegistryState = await getOracleState();

    const dataServiceId = getDataServiceIdForSigner(
      oracleRegistryState,
      signerAddress
    );

    const dataPackagesForSaving = receivedDataPackages.map(
      (receivedDataPackage) =>
        DataPackagesService.prepareDataPackageForSaving(
          receivedDataPackage,
          signerAddress,
          dataServiceId
        )
    );

    return dataPackagesForSaving;
  }

  private static prepareDataPackageForSaving(
    receivedDataPackage: ReceivedDataPackage,
    signerAddress: string,
    dataServiceId: string
  ) {
    const isSignatureValid = DataPackagesService.isSignatureValid(
      receivedDataPackage,
      signerAddress
    );

    const cachedDataPackage: CachedDataPackage = {
      ...receivedDataPackage,
      dataServiceId,
      signerAddress,
      isSignatureValid,
    };
    if (receivedDataPackage.dataPoints.length === 1) {
      cachedDataPackage.dataFeedId =
        receivedDataPackage.dataPoints[0].dataFeedId;
    } else {
      cachedDataPackage.dataFeedId = consts.ALL_FEEDS_KEY;
    }
    return cachedDataPackage;
  }

  private static isSignatureValid(
    receivedDataPackage: ReceivedDataPackage,
    signerAddress: string
  ): boolean {
    try {
      const address = recoverDeserializedSignerAddress(receivedDataPackage);

      return address === signerAddress;
    } catch {
      return false;
    }
  }
}
