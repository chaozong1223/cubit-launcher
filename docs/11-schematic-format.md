# 11 投影文件格式规格（.litematic / .schem / .nbt）

> 用途：`t4 投影管理` 的实现依据。基于公开规范与真实样本查证整理（2026-10-22）。
> 状态：草案。实现时以仓内真实样本复核，**任何字段名与实际文件不符都要先修本文档再改代码**。

## 0. 一句话

三种文件都是 **gzip 外壳 + Java 大端 NBT**；扩展名不可靠，必须解压后读根 compound 的首层键来判定格式。

## 1. 字节结构

文件偏移 0 读 2 字节：

- `1F 8B` → gzip（**注意**：gzip 头含可变的 FNAME 字段，不要硬编码"跳过 10 字节"）
- `78 ..` → zlib
- `0A` → 未压缩 NBT

解压后偏移 0 即 NBT 根：`0A` + u16 根名长度 + 根名 + payload。

Tag 类型：1 Byte、2 Short、3 Int、4 Long、5 Float、6 Double、7 ByteArray、8 String、
9 List、10 Compound、11 IntArray、12 LongArray。全部大端。

- Compound：重复「tag id + u16 名长 + 名 + payload」，遇 `00` 结束
- String：u16 **字节数**长度前缀（中文/emoji 按字节算）
- List：u8 元素类型 + i32 个数

**根名不可靠**：litematic 根名通常为空（`0A 0000`），不能靠根名识别格式。

## 2. litematic

识别键：首层同时存在 `Version`、`Metadata`、`Regions`。

| 字段路径 | 类型 | 说明 |
|---|---|---|
| `Metadata.EnclosingSize.{x,y,z}` | Int（小写键） | 总尺寸 |
| `Metadata.TotalVolume` | **Int**（不是 Long） | 方块总数 |
| `Metadata.Name/Author/Description` | String | 显示用 |
| `Metadata.RegionCount` | Int | 区域数 |
| `Metadata.TimeCreated/TimeModified` | Long | Unix 毫秒 |
| `Regions.<name>.Size.{x,y,z}` | Int | **可为负**，尺寸取 `abs` |
| `Regions.<name>.Position.{x,y,z}` | Int | 可为负 |
| 根 `Version` | Int | 1..6（当前 6） |

**负尺寸是正常的方向表示，不是损坏**。真实样本里 4 个 region 的 `Size.y` 分别为
-11/-8/-14/-10，而 `TotalVolume=283` 恰等于 Σ|xyz|。

坐标换算：`end = pos + (size > 0 ? size - 1 : size + 1)`，再与 `pos` 取 min/max。

**溢出**：超大工程的 `TotalVolume` 可能 32 位溢出 → 展示时用逐 region 求和，或用
`EnclosingSize` 校正，不要直接信这个数。

## 3. .schem

先纠正命名：**旧 MCEdit 格式的规范扩展名是 `.schematic`**；`.schem` 是 Sponge v1+。
两者都是 gzip+NBT，**头字节无法区分**，必须看解压后根 compound 的首层键。

| 判定 | 特征 | 尺寸 |
|---|---|---|
| MCEdit | 根名 `Schematic` + `Materials`(String) + `Blocks`(ByteArray)，无 `Version` | `Width/Height/Length`(Short) |
| Sponge v1/v2 | 根名 `Schematic` + `Version`=1/2 + `Palette` + `BlockData` | 同上，Short 按 unsigned（`& 0xffff`） |
| Sponge v3 | 根（名不限）含子 compound `Schematic` + `Version`=3 | `Schematic.Width/Height/Length` |

典型头字节：v1/2 与 MCEdit 为 `0A 0009 "Schematic"`；v3 为 `0A 0000 0A 0009 "Schematic"`。
**2 字节 magic 不够**，必须读到首层键。

## 4. .nbt 的三种载荷

`.nbt` 只是扩展名，内容可能是：

1. **原版结构方块文件**：无名根 + `size`(List<Int>[3]) + `palette`/`blocks`/`entities`/`DataVersion`，无 `Version` → 读 `size[0..2]`
2. **Sponge 存成 .nbt**：按第 3 节识别
3. **litematic 改名**：读 `Metadata.EnclosingSize`，缺失时用 region 并集

## 5. 判定顺序

```
litematic（Version + Metadata + Regions）
  → Sponge v3（子 Schematic + Version=3）
  → MCEdit（Materials）
  → Sponge v1/v2（Version 1/2）
  → 原版结构（size List）
  → 报不支持的格式
```

## 6. TypeScript 接口草案

```ts
export type TagType = 0|1|2|3|4|5|6|7|8|9|10|11|12
export type Tag =
  | { type: 'byte'|'short'|'int'|'float'|'double'; value: number }
  | { type: 'long'; value: bigint }
  | { type: 'string'; value: string }
  | { type: 'byteArray'|'intArray'|'longArray'; value: Buffer }  // 大端，零拷贝
  | { type: 'list'; elementType: TagType; value: Tag[] }
  | { type: 'compound'; value: Map<string, Tag> }
  | { type: 'skipped'; byteLength: number }

export interface NbtLimits {
  maxDepth?: number              // 默认 64
  maxArrayLength?: number        // 默认 1e6
  maxDecompressedBytes?: number  // 默认 256 MiB
  skipArrays?: boolean           // 列表页传 true
}

export interface NbtFile { compression: 'gzip'|'zlib'|'none'; root: CompoundTag }

export interface Vec3 { x: number; y: number; z: number }
export interface RegionInfo { name: string; pos: Vec3; size: Vec3 }  // size 取 abs

export interface SchematicInfo {
  format: 'litematic'|'sponge-v1'|'sponge-v2'|'sponge-v3'|'mcedit'|'structure'
  version?: number
  size: Vec3
  name?: string; author?: string; description?: string
  regionCount?: number; timeCreated?: number; timeModified?: number
  regions?: RegionInfo[]
}

export function readNbtFile(buf: Buffer, limits?: NbtLimits): NbtFile
export function readSchematic(buf: Buffer, limits?: NbtLimits): SchematicInfo
```

错误码：在 `core/errors.ts` 的 `CORE_ERRORS` 增加 `SCHEMATIC.INVALID`、`SCHEMATIC.LIMIT_EXCEEDED`。

## 7. 必须覆盖的边界用例

1. 0 字节 / 只有 gzip 头 / 解压后为空
2. gzip 损坏、CRC 错、deflate 截断
3. gzip bomb（解压后 10 GB）
4. 上万层嵌套
5. List/数组长度 `0x7FFFFFFF`、负数、超出剩余字节
6. String 长度越界、空串、中文与 emoji（emoji 的 modified UTF-8 可占 6 字节）
7. `Region.Size` 负值、`Position` 负值
8. `Metadata` 缺失或类型错、`RegionCount` 与实际不符、List 元素类型 `0`、根节点后尾随字节

## 8. 安全防护（必须实现，不是可选）

- `zlib.gunzipSync` 传入 `maxOutputLength`；限制压缩文件本身大小
- 数组/List 先校验 `len >= 0 && len * elemSize <= remaining`，再分配或跳过
- 列表页 `skipArrays = true`，数组用 `Buffer.subarray` 零拷贝
- 解析改迭代或强制 `depth <= 64`；限制 compound 子键数与 region 数
- Long 用 `bigint`，展示前检查 `Number.isSafeInteger`
- compound 用 `Map`，避免 `__proto__` 污染

## 9. 来源

- [NBT 格式](https://minecraft.wiki/w/NBT_format)
- [结构文件](https://minecraft.wiki/w/Structure_file)
- [Schematic 文件格式](https://minecraft.wiki/w/Schematic_file_format)
- [Sponge v2 规范](https://github.com/SpongePowered/Schematic-Specification/blob/master/versions/schematic-2.md)
- [Sponge v3 规范](https://github.com/SpongePowered/Schematic-Specification/blob/master/versions/schematic-3.md)
- [Litematica SchematicMetadata](https://github.com/maruohon/litematica/blob/pre-rewrite/fabric/1.20.x/src/main/java/fi/dy/masa/litematica/schematic/SchematicMetadata.java#L150-L194)
- [WorldEdit 格式表](https://github.com/EngineHub/WorldEdit/blob/master/worldedit-core/src/main/java/com/sk89q/worldedit/extent/clipboard/io/BuiltInClipboardFormat.java#L52-L172)
