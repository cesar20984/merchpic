# MerchPic

App mobile-first para capturar fotos de productos y generar imagenes comerciales con OpenAI.

## Deploy en Vercel con Neon

1. Crea una base de datos en Neon.
2. Copia el connection string de Neon.
3. En Vercel, importa este repositorio.
4. Agrega estas variables de entorno en Vercel:

```env
OPENAI_API_KEY=tu_api_key_de_openai
DATABASE_URL=postgresql://usuario:password@host.neon.tech/db?sslmode=require
CRON_SECRET=un_texto_largo_aleatorio
```

5. Despliega.

El backend crea automaticamente las tablas necesarias en Neon la primera vez que se ejecuta.

## Local

```bash
npm install
npm run dev
```

Para correr local tambien necesitas `OPENAI_API_KEY` y `DATABASE_URL` en `.env`.

## Notas

- Las fotos originales y las imagenes generadas se guardan en Neon.
- Vercel no mantiene archivos subidos en disco, por eso la app no depende de carpetas locales para produccion.
- La generacion usa las fotos del producto como imagenes de referencia con el endpoint de edicion de imagenes de OpenAI.
- Las imagenes se inician como tareas background de OpenAI y Vercel Cron revisa tareas pendientes para guardar resultados en Neon.
- El navegador comprime las fotos antes de subirlas para reducir errores por limite de payload en Vercel.
- Si el uso crece mucho, conviene mover los binarios a Vercel Blob o S3 y dejar en Neon solo metadatos y URLs.
