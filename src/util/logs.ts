import { getLogs as getLogsV1 } from ".";
import { EventLog, Interface, id } from "ethers";
import { Address } from "../types";
import { getBlock } from "./blocks";
import { readCache, writeCache } from "./cache";
import { debugLog } from "./debugLog";

const currentVersion = 'v2'

export type GetLogsOptions = {
  target: Address;
  topic?: string;
  keys?: string[]; // This is just used to select only part of the logs
  fromBlock?: number;
  toBlock?: number;
  topics?: string[];
  extraTopics?: string[];
  chain?: string;
  eventAbi?: string | any;
  fromTimestamp?: number;
  toTimestamp?: number;
  skipCache?: boolean;
  skipCacheRead?: boolean;
  entireLog?: boolean;
  cacheInCloud?: boolean;
  onlyArgs?: boolean;
}

export async function getLogs({
  target,
  chain = 'ethereum',
  fromBlock,
  toBlock,
  fromTimestamp,
  toTimestamp,
  eventAbi,
  topic,
  topics,
  extraTopics, // can be passed as input as extra filter arguments
  skipCache = false,
  skipCacheRead = false,
  entireLog = false,
  cacheInCloud = false,
  onlyArgs = false,
  keys = [], //  [Deprecated] This is just used to select only part of the logs
}: GetLogsOptions): Promise<EventLog[]|any[]> {
  if (!target) throw new Error('target is required')
  if (!fromBlock && !fromTimestamp) throw new Error('fromBlock or fromTimestamp is required')
  if (!toBlock && !toTimestamp) throw new Error('toBlock or toTimestamp is required')

  if (!fromBlock)
    fromBlock = (await getBlock(chain, fromTimestamp)).block

  if (!toBlock)
    toBlock = (await getBlock(chain, toTimestamp)).block

  let iface: Interface | undefined

  if ((!topics || !topics.length) && !topic) {
    if (topic) {
      topic = toFilterTopic(topic)
    } else if (eventAbi) {
      iface = new Interface([eventAbi])
      topic = toFilterTopic(iface)
    } else {
      throw new Error('eventAbi | topic | topics are required')
    }
    topics = [topic]
    if (extraTopics) topics.push(...extraTopics)
  }

  const cacheData = (await _getCache() as logCache)
  const isFirstRun = !cacheData.metadata
  if (isFirstRun) cacheData.metadata = { version: currentVersion } as any

  if (isFirstRun) {
    await addLogsToCache(fromBlock, toBlock)
  } else {
    const metadata = cacheData.metadata!
    if (fromBlock < metadata.fromBlock)
      await addLogsToCache(fromBlock, metadata.fromBlock - 1)
    if (toBlock > metadata.toBlock)
      await addLogsToCache(metadata.toBlock + 1, toBlock)
  }

  const logs = cacheData.logs.filter((i: EventLog) => {
    if (i.blockNumber < fromBlock!) return false
    if (i.blockNumber > toBlock!) return false
    return true
  })

  if (!eventAbi || entireLog) return logs
  return logs.map(i => iface!.parseLog(i as any)).map((i: any) => onlyArgs ? i.args : i)

  async function addLogsToCache(fromBlock: number, toBlock: number) {
    const metadata = cacheData.metadata!
    
    let logs = (await getLogsV1({
      chain, target, topic: topic as string, keys, topics, fromBlock, toBlock,
    })).output
    cacheData.logs.push(...logs)


    const logIndices = new Set()

    cacheData.logs = cacheData.logs.filter((i: EventLog) => {
      let key = i.transactionHash + ((i as any).logIndex ?? i.index) // ethers v5 had logIndex, ethers v6 has index
      if (!(i.hasOwnProperty('logIndex') || i.hasOwnProperty('index')) || !i.hasOwnProperty('transactionHash')) {
        debugLog(i, (i as any).logIndex, i.index, i.transactionHash)
        throw new Error('Missing crucial field')
      }
      if (logIndices.has(key)) return false
      logIndices.add(key)
      return true
    })

    if (!metadata.fromBlock || fromBlock < metadata.fromBlock) metadata.fromBlock = fromBlock
    if (!metadata.toBlock || toBlock > metadata.toBlock) metadata.toBlock = toBlock

    if (!skipCache)
      await writeCache(getFile(), cacheData, { skipR2CacheWrite: !cacheInCloud })
  }

  async function _getCache() {
    const key = getFile()
    const defaultRes = {
      logs: [],
    }

    if (skipCache || skipCacheRead) return defaultRes

    let cache = await readCache(key, { skipR2Cache: !cacheInCloud })

    if (!cache.metadata || cache.metadata.version !== currentVersion)
      return defaultRes

    return cache
  }

  function getFile() {
    let extraKey = topics?.join('-').toLowerCase()
    if (!extraKey) throw new Error('extraKey is required')
    if (keys.length) extraKey += '-' + keys.join('-').toLowerCase()

    return `event-logs/${chain}/${target.toLowerCase()}/${target.toLowerCase()}`
  }

  // we need to form filter topic with indexed keyword, else it messes up generated topic string
  function toFilterTopic(topic: string | Interface) {
    if (typeof topic === 'string') {
      if (topic.startsWith('0x')) return topic
      topic = new Interface([topic])
    }

    const fragment: any = topic.fragments[0]
    return id(`${fragment.name}(${fragment.inputs.map((i: any) => i.type).join(',')})`)
  }
}

export type logCache = {
  logs: EventLog[],
  metadata?: {
    version: string,
    fromBlock: number,
    toBlock: number,
  }
}

export default getLogs