import { appSettings } from "../../../configs/app-settings";

const { minio } = appSettings;

export type Media = {
    filename: string;
    disk: string;
};

export const transferValuePathFile = (file: Media): string => {
    const { filename, disk } = file;
    return `${minio.public}/${disk}/${filename}`;
};

export const transferValuePathFileV2 = (file: any): string => {
    const { name, bucket } = file;
    return `${minio.public}/${bucket}/${name}`;
};

