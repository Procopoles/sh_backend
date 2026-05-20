type MaterialIconProps = {
  name: string;
  size?: number;
  className?: string;
};

export function MaterialIcon({ name, size = 18, className = "" }: MaterialIconProps) {
  return (
    <span className={`material-symbols-outlined ${className}`} style={{ fontSize: size }} aria-hidden="true">
      {name}
    </span>
  );
}
