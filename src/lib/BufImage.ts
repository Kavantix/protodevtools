// To parse this data:
//
//   import { Convert, Welcome } from "./file";
//
//   const welcome = Convert.toWelcome(json);
import {
  type DescMessage,
  type DescService,
  type Registry,
  create,
  fromBinary,
} from "@bufbuild/protobuf";
import path from "path-browserify-esm";

export function extractInfoFromURL(rawURL: string) {
  const url = new URL(rawURL);
  const serviceName = path.dirname(url.pathname).split("/").pop();
  const methodName = path.basename(url.pathname);
  return {
    serviceName,
    methodName,
  };
}

// GRPC first byte is a compression indictor, the next 4 bytes are the size of the message
export function removeGrpcEncoding(b: Buffer): Buffer {
  const size = b.readUint32BE(1);
  return b.subarray(5, size + 5);
}

export function humanizeRequest(image: Registry, a: Buffer, url: string) {
  const method = getMethod(image, url);
  if (!method) {
    return null;
  }
  return Humanize(image, a, method.input);
}

export function humanizeResponse(image: Registry, a: Buffer, url: string) {
  const method = getMethod(image, url);
  if (!method) {
    return null;
  }
  return Humanize(image, a, method.output);
}

export function getMethod(image: Registry, url: string) {
  const { serviceName, methodName } = extractInfoFromURL(url);
  const service = image.getService(serviceName);
  console.debug("service", service);
  const method = service?.methods.find((v) => v.name == methodName);
  return method;
}

export function Humanize(
  image: Registry,
  a: Buffer,
  messageDescription: DescMessage,
) {
  console.debug("messageDescription", messageDescription, a);
  a = removeGrpcEncoding(a);

  const message = fromBinary(messageDescription, a);
  humanizeEnums(message, messageDescription, image);
  console.log("humanized message", message);
  return message;
}

function humanizeEnums(
  message: any,
  messageDescription: DescMessage,
  image: Registry,
): void {
  for (const field of messageDescription.fields) {
    let msg = message;
    if (field.oneof != undefined && field.oneof.kind == "oneof") {
      if (message[field.oneof.localName]?.case != field.localName) {
        continue;
      }
      console.log("field is a oneof", field);
      console.log(
        "message[field.oneof.localName]",
        message[field.oneof.localName],
      );
      msg = {};
      msg[field.localName] = message[field.oneof.localName].value;
    }
    if (field.fieldKind == "enum") {
      const enumType = field.enum;
      if (enumType) {
        const enumValue = enumType.values.find(
          (v) => v.number == msg[field.localName],
        );
        if (enumValue) {
          msg[field.localName] = enumValue.localName;
        }
      }
    } else if (field.fieldKind == "message") {
      console.log("field is a message of type", field.proto.typeName);
      if (field.proto.typeName == ".google.protobuf.Timestamp") {
        const timestamp = msg[field.localName];
        console.log("timestamp", timestamp);
        if (timestamp) {
          const seconds = Number(timestamp.seconds);
          const nanos = timestamp.nanos;
          const date = new Date(seconds * 1000 + nanos / 1e6);
          msg[field.localName] = date.toISOString();
        }
        continue;
      }
      const nestedMessageDescription = field.message;
      if (msg[field.localName] && nestedMessageDescription) {
        humanizeEnums(msg[field.localName], nestedMessageDescription, image);
      }
    } else if (field.fieldKind == "list") {
      console.log("field is a list", field);
      console.debug("message[field.name]", msg[field.localName]);
      if (field.listKind == "message") {
        for (const item of msg?.[field.localName] ?? []) {
          humanizeEnums(item, field.message!, image);
        }
      } else if (field.listKind == "enum") {
        const enumType = field.enum;
        if (enumType) {
          for (let i = 0; i < (msg?.[field.localName]?.length ?? 0); i++) {
            const enumValue = enumType.values.find(
              (v) => v.number == msg[field.localName][i],
            );
            if (enumValue) {
              msg[field.localName][i] = enumValue.localName;
            }
          }
        }
      }
    }
  }
  return;
}
