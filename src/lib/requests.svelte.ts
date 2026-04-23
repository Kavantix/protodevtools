import { Buffer } from "buffer";
import JSBI from "jsbi";
import { BufferReader } from "./BufferReader"; // Adjust the path as necessary
import { base64Decode } from "@bufbuild/protobuf/wire";
import { humanizeResponse, humanizeRequest } from "./BufImage";
import fileRegistry from "./fileRegistry.svelte";
import requestJSON from "./testfiles/localdev/request.json";
import responseJSON from "./testfiles/localdev/response.json";
import type { Header } from "har-format";

function recurse(obj: any, parsedData: any) {
  for (let p of parsedData.parts) {
    switch (p.type) {
      case 0:
        obj[p.index] = decodeVarintParts(p.value);
        break;
      case 1:
        obj[p.index] = decodeFixed64(p.value);
        break;
      case 2:
        let decoded = decodeProto(p.value);
        if (p.value.length > 0 && decoded.leftOver.length === 0) {
          obj[p.index] = {};
          recurse(obj[p.index], decoded);
        } else {
          obj[p.index] = decodeStringOrBytes(p.value);
        }
        break;
      case 5:
        obj[p.index] = decodeFixed32(p.value);
        break;
    }
  }

  if (parsedData.leftOver.length > 0) {
    const p = decodeProto(parsedData.leftOver);
    if (p.parts.length > 0) {
      recurse(obj, p);
    }
  }
  return obj;
}

function decodeProto(buffer: any) {
  const TYPES = {
    VARINT: 0,
    FIXED64: 1,
    LENDELIM: 2,
    FIXED32: 5,
  };

  const reader = new BufferReader(buffer) as any;
  const parts = [];

  reader.trySkipGrpcHeader();

  try {
    while (reader.leftBytes() > 0) {
      reader.checkpoint();

      const byteRange = [reader.offset];
      const indexType = parseInt(reader.readVarInt().toString());
      const type = indexType & 0b111;
      const index = indexType >> 3;

      let value;
      if (type === TYPES.VARINT) {
        value = reader.readVarInt().toString();
      } else if (type === TYPES.LENDELIM) {
        const length = parseInt(reader.readVarInt().toString());
        value = reader.readBuffer(length);
      } else if (type === TYPES.FIXED32) {
        value = reader.readBuffer(4);
      } else if (type === TYPES.FIXED64) {
        value = reader.readBuffer(8);
      } else {
        throw new Error("Unknown type: " + type);
      }
      byteRange.push(reader.offset);

      parts.push({
        byteRange,
        index,
        type,
        value,
      });
    }
  } catch (err) {
    console.log(err);
    reader.resetToCheckpoint();
  }

  return {
    parts,
    leftOver: reader.readBuffer(reader.leftBytes()),
  };
}

export function decodeStringOrBytes(value: any) {
  if (!value.length) {
    return { type: "string|bytes", value: "" };
  }
  const td = new TextDecoder("utf-8", { fatal: true });
  try {
    return { type: "string", value: td.decode(value) };
  } catch (e) {
    return { type: "bytes", value: value };
  }
}

export function decodeVarintParts(value: any) {
  const result = [];
  const uintVal = JSBI.BigInt(value);
  result.push({ type: "uint", value: uintVal.toString() });

  for (const bits of [8, 16, 32, 64]) {
    const intVal = interpretAsTwosComplement(uintVal, bits);
    if (intVal !== uintVal) {
      result.push({ type: "int" + bits, value: intVal.toString() });
    }
  }

  const signedIntVal = interpretAsSignedType(uintVal);
  if (signedIntVal !== uintVal) {
    result.push({ type: "sint", value: signedIntVal.toString() });
  }

  return result;
}

export function decodeFixed32(value: any) {
  const floatValue = value.readFloatLE(0);
  const intValue = value.readInt32LE(0);
  const uintValue = value.readUInt32LE(0);

  const result = [];

  result.push({ type: "int", value: intValue });

  if (intValue !== uintValue) {
    result.push({ type: "uint", value: uintValue });
  }

  result.push({ type: "float", value: floatValue });

  return result;
}

export function decodeFixed64(value: any) {
  const floatValue = value.readDoubleLE(0);
  const uintValue = JSBI.BigInt("0x" + bufferLeToBeHex(value));
  const intValue = interpretAsTwosComplement(uintValue, 64);

  const result = [];

  result.push({ type: "int", value: intValue.toString() });

  if (intValue !== uintValue) {
    result.push({ type: "uint", value: uintValue.toString() });
  }

  result.push({ type: "double", value: floatValue });

  return result;
}

export function bufferLeToBeHex(buffer: any) {
  let output = "";
  for (const v of buffer) {
    const hex = v.toString(16);
    if (hex.length === 1) {
      output = "0" + hex + output;
    } else {
      output = hex + output;
    }
  }
  return output;
}

export function interpretAsSignedType(n: any) {
  // see https://github.com/protocolbuffers/protobuf/blob/master/src/google/protobuf/wire_format_lite.h#L857-L876
  // however, this is a simpler equivalent formula
  const isEven = JSBI.equal(JSBI.bitwiseAnd(n, JSBI.BigInt(1)), JSBI.BigInt(0));
  if (isEven) {
    return JSBI.divide(n, JSBI.BigInt(2));
  } else {
    return JSBI.multiply(
      JSBI.BigInt(-1),
      JSBI.divide(JSBI.add(n, JSBI.BigInt(1)), JSBI.BigInt(2)),
    );
  }
}

export function interpretAsTwosComplement(n: any, bits: any) {
  const isTwosComplement = JSBI.equal(
    JSBI.signedRightShift(n, JSBI.BigInt(bits - 1)),
    JSBI.BigInt(1),
  );
  if (isTwosComplement) {
    return JSBI.subtract(n, JSBI.leftShift(JSBI.BigInt(1), JSBI.BigInt(bits)));
  } else {
    return n;
  }
}

let requests: Request[] = $state([]);

function parseMessageType(
  headers: { name: string; value: string }[],
): "base64" | "raw" | null {
  const contentType = headers.find(
    (h) => h.name.toLowerCase() === "content-type",
  )?.value;
  if (typeof contentType !== "string") {
    return null;
  }
  if (contentType.includes("application/grpc-web-text")) {
    return "base64";
  } else if (contentType.includes("application/grpc-web+proto")) {
    return "raw";
  } else {
    return null;
  }
}

function base64Encode(input: string): string {
  return Buffer.from(input).toString("base64");
}

const rawRequests: HARFormatEntry[] = [];
let lastStartedDateTime = "2000-01-01T00:00:00.000Z";

const textDecoder = new TextDecoder();
setInterval(() => {
  chrome?.devtools?.network?.getHAR((har) => {
    const newEntries = har.entries.filter(
      (e) =>
        e.request.method === "POST" && e.startedDateTime > lastStartedDateTime,
    );
    for (const entry of newEntries) {
      rawRequests.push(entry);
      lastStartedDateTime = entry.startedDateTime;
      console.debug("new entry", entry);
      addRequest(entry as any);
    }
  });
}, 500);

const addRequest = (
  entry: HARFormatEntry & {
    getContent(callback: (content?: string) => void): void;
  },
) => {
  console.debug("request", entry);
  const messageType = parseMessageType(entry.request.headers);
  if (!messageType) {
    console.debug("skipping non-grpc request", entry.request.url);
    return;
  }
  if (!entry.request.postData || !entry.request.postData.text) {
    console.debug("skipping request with no post data", entry.request.url);
    return;
  }

  const bytes = Buffer.from(
    messageType === "base64"
      ? base64Decode(entry.request.postData!.text!)
      : entry.request.postData!.text,
  );

  let data: any = {};
  try {
    if (fileRegistry.activeFileRegistry) {
      data = humanizeRequest(
        fileRegistry.activeFileRegistry.fileRegistry,
        bytes,
        entry.request.url,
      );
    } else {
      data = recurse({}, decodeProto(bytes));
    }
  } catch (e) {
    console.log("error decoding proto", e);
  }
  const request: Request = {
    requestTime: new Date(entry.startedDateTime),
    data: data,
    url: entry.request.url,
    method: entry.request.method as "POST" | "GET",
    status: entry.response.status,
  };
  requests.push(request);
  entry.getContent((_) => {
    setTimeout(() => {
      entry.getContent((body) => {
        // the body is always base64 at least once
        const bodyDecoded = base64Decode(body ?? "");
        const messageType = parseMessageType(entry.response.headers);
        const bytes = Buffer.from(
          messageType === "base64"
            ? base64Decode(textDecoder.decode(bodyDecoded))
            : bodyDecoded,
        );
        console.debug(
          "url",
          request.url,
          "response bytes",
          bytes,
          "messageType",
          messageType,
        );
        request.status = entry.response.status;
        if (request.status == 200) {
          request.grpcStatus = parseGrpcStatus(entry.response.headers);
        }
        try {
          if (fileRegistry.activeFileRegistry) {
            request.response = {
              rawData: body,
              data: humanizeResponse(
                fileRegistry.activeFileRegistry.fileRegistry,
                bytes,
                request.url,
              ),
            };
          } else {
            const recursed = recurse({}, decodeProto(bytes));
            request.response = { data: recursed, rawData: body };
          }
          const index = requests.findIndex(
            (r) => r.requestTime.getTime() === request.requestTime.getTime(),
          );
          if (index !== -1) {
            requests[index] = request;
          }
        } catch (e) {
          console.log("error decoding response", e);
        }
      });
    }, 50);
  });
};

if (chrome?.devtools?.network?.onRequestFinished?.addListener) {
  chrome.devtools.network.onRequestFinished.addListener((request: any) => {
    return;
    if (request.request.method != "POST") {
      return;
    }
    let r: Request = {
      requestTime: new Date(),
      data,
      url: request.request.url,
      method: "POST",
    };
    request.getContent((body: any) => {
      // the body is always base64 at least once
      body = base64Decode(body);
      const messageType = parseMessageType(request.response.headers);
      const bytes = Buffer.from(
        messageType === "base64"
          ? base64Decode(new TextDecoder().decode(body))
          : body,
      );
      console.debug(
        "url",
        r.url,
        "response bytes",
        bytes,
        "messageType",
        messageType,
      );
      try {
        if (fileRegistry.activeFileRegistry) {
          r.response = {
            rawData: body,
            data: humanizeResponse(
              fileRegistry.activeFileRegistry.fileRegistry,
              bytes,
              r.url,
            ),
          };
        } else {
          const recursed = recurse({}, decodeProto(bytes));
          r.response = {
            data: recursed,
            rawData: body,
          };
        }
      } catch (e) {
        console.log("error decoding response", e);
      }
      requests.push(r);
    });
  });
} else {
  // this is not an extension right now, so add fake data

  requests.push({
    requestTime: new Date(),
    data: requestJSON,
    url: "http://localhost:8080/greeter.Greeter/SayHello",
    method: "POST",
    response: {
      data: responseJSON,
      rawData: "",
    },
  });
}

type Response = {
  data: any;
  rawData: any;
};

export enum GrpcStatusCode {
  OK,
  CANCELLED,
  UNKNOWN,
  INVALID_ARGUMENT,
  DEADLINE_EXCEEDED,
  NOT_FOUND,
  ALREADY_EXISTS,
  PERMISSION_DENIED,
  RESOURCE_EXHAUSTED,
  FAILED_PRECONDITION,
  ABORTED,
  OUT_OF_RANGE,
  UNIMPLEMENTED,
  INTERNAL,
  UNAVAILABLE,
  DATA_LOSS,
  UNAUTHENTICATED,
}

export type Request = {
  requestTime: Date;
  data: any;
  url: string;
  method: "POST" | "GET";
  response?: Response;
  status: number;
  grpcStatus?:
    | {
        code: GrpcStatusCode.OK;
      }
    | {
        code: GrpcStatusCode;
        message?: string;
      };
};

export default {
  get requests() {
    return requests;
  },
  addRequest(r: Request) {
    requests.push(r);
  },
};
function parseGrpcStatus(
  headers: Header[],
):
  | { code: GrpcStatusCode.OK }
  | { code: GrpcStatusCode; message?: string }
  | undefined {
  const grpcStatusHeader = headers.find(
    (header) => header.name.toLowerCase() === "grpc-status",
  );
  if (!grpcStatusHeader) {
    return { code: GrpcStatusCode.OK };
  }
  const grpcStatus = parseInt(grpcStatusHeader.value, 10);
  if (grpcStatus === GrpcStatusCode.OK) {
    return { code: GrpcStatusCode.OK };
  }
  const grpcMessageHeader = headers.find(
    (header) => header.name.toLowerCase() === "grpc-message",
  );
  return {
    code: grpcStatus,
    message: grpcMessageHeader?.value,
  };
}
