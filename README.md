<p align="center">
  <img src="assets/banner.png" alt="Perception Studio" width="720" />
</p>

<p align="center">
  Browser-native 3D perception explorer for Waymo Open Dataset v2.0 Perception<br/>
  No install. No server. Your data never leaves your browser.
</p>

<p align="center">
  <a href="https://happyhj.github.io/waymo-perception-studio"><strong>✦ Live Demo</strong></a>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/ca5566ed-f2f2-42ad-8c13-b05d9150aacc" alt="Perception Studio screenshot" width="720" />
</p>

## The Problem

[Waymo Open Dataset](https://waymo.com/open/) is one of the richest public self-driving datasets out there, but actually looking at the data is painful. The [official tools](https://github.com/waymo-research/waymo-open-dataset) need Python + TensorFlow. Jupyter gives you static plots. [Foxglove](https://foxglove.dev/) is paid. And you can't even use the raw Parquet files without preprocessing scripts.

You just want to drop in the files and see what's inside.

## What's Inside

- **See what the car sees**: explore real self-driving scenes in 3D with LiDAR point clouds and 5 synchronized camera views
- **3D object models**: vehicles, pedestrians, and cyclists rendered as 3D models with color-coded tracking
- **Camera POV mode**: click a camera to jump into its viewpoint in 3D, compare what the sensor sees side by side
- **Cross-modal linking**: hover over a camera detection and its 3D counterpart lights up, and vice versa

<p align="center">
  <img src="https://github.com/user-attachments/assets/8ca4aa6e-5818-4d2f-bed2-58687dd825d8" alt="LiDAR point cloud driving scene" width="720" />
</p>

<table>
  <tr>
    <td><img src="https://github.com/user-attachments/assets/0c99b33b-59d8-4fcb-9a47-cba7bdaa51fa" alt="3D model rendering and POV switching" /></td>
    <td><img src="https://github.com/user-attachments/assets/f8c9f708-dce1-4313-8de8-1da3ac727788" alt="Bounding boxes and POV transition" /></td>
  </tr>
</table>

## 🚀 Try It With Your Waymo Data

**Already have Waymo Open Dataset v2.0 Perception downloaded?** Just open the [live demo](https://happyhj.github.io/waymo-perception-studio), drop your files, and go.

**Don't have the data yet?** It's free with a Google account.

<details>
<summary><strong>Download script</strong></summary>

```bash
# Install Google Cloud CLI: https://cloud.google.com/sdk/docs/install
gcloud auth login

BUCKET="gs://waymo_open_dataset_v_2_0_1/training"
COMPONENTS="vehicle_pose lidar_calibration camera_calibration lidar_box lidar lidar_camera_projection camera_image"
N=1  # Number of segments to download (~500 MB each)

SEGMENTS=$(gsutil ls "$BUCKET/vehicle_pose/*.parquet" | head -$N | xargs -I{} basename {} .parquet)

for SEG in $SEGMENTS; do
  echo "Downloading $SEG"
  for C in $COMPONENTS; do
    mkdir -p waymo_data/$C
    gsutil -m cp "$BUCKET/$C/$SEG.parquet" "waymo_data/$C/"
  done
done
```

</details>

Then drag & drop the `waymo_data/` folder into the app.

## Dev Setup

```bash
git clone https://github.com/heejaekim/waymo-perception-studio.git
cd waymo-perception-studio
npm install
npm run dev
```

## Built With

React 19 · TypeScript · Three.js · R3F · Vite · Zustand · hyparquet · Web Workers

## Browser Support

Chrome / Edge recommended (folder drag & drop + folder picker). Firefox / Safari support folder drag & drop only.

## License

MIT
