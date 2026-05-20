import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Controle de Publicacoes",
  description: "Gerenciamento de portais e regras de publicacao de imoveis",
  icons: {
    icon: [
      {
        url: "/brand/sh-gerenciamento-icone.png",
        type: "image/png"
      }
    ],
    apple: "/brand/sh-gerenciamento-icone.png"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
