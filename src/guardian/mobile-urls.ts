import { isAnyAddress, isLoopbackAddress, listLanIpv4Addresses } from "./config";

export function buildGuardianMobileUrls(input: {
  controlBind: string;
  port: number;
  controlSecret: string;
}): string[] {
  const token = encodeURIComponent(input.controlSecret);
  if (isLoopbackAddress(input.controlBind)) {
    return [`http://127.0.0.1:${input.port}/mobile?token=${token}`];
  }
  if (isAnyAddress(input.controlBind)) {
    const lan = listLanIpv4Addresses();
    if (lan.length === 0) {
      return [`http://127.0.0.1:${input.port}/mobile?token=${token}`];
    }
    return lan.map((address) => `http://${address}:${input.port}/mobile?token=${token}`);
  }
  return [`http://${input.controlBind}:${input.port}/mobile?token=${token}`];
}
