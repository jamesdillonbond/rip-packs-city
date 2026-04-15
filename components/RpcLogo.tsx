type RpcLogoProps = {
  size?: number;
  className?: string;
};

export default function RpcLogo({ size = 32, className }: RpcLogoProps) {
  return (
    <img
      src="/rip-packs-city-logo.png"
      alt="Rip Packs City"
      width={size}
      height={size}
      className={className}
      style={{ width: size, height: size, display: "block", objectFit: "contain" }}
    />
  );
}
