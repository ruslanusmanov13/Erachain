package org.erachain.gui.library;

import org.erachain.gui.items.ImageCropDialog;
import org.erachain.gui.items.assets.CreateOrderPanel;
import org.erachain.lang.Lang;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.imageio.ImageIO;
import javax.swing.*;
import javax.swing.filechooser.FileNameExtensionFilter;
import java.awt.*;
import java.awt.event.*;
import java.awt.image.BufferedImage;
import java.io.*;


public class AddImageLabel extends JLabel {

    private static final long serialVersionUID = 1L;
    private byte[] imgBytes;
    private String imageLabelText;
    private int bezelWidth;
    private int bezelHeight;
    private Logger logger = LoggerFactory.getLogger(getClass().getName());

    public AddImageLabel(String text, int bezelWidth, int bezelHeight) {
        this.bezelWidth = bezelWidth;
        this.bezelHeight = bezelHeight;
        imageLabelText = text;
        setCursor(new Cursor(Cursor.HAND_CURSOR));
        setBorder(BorderFactory.createEtchedBorder());
        setVerticalAlignment(SwingConstants.TOP);
        setHorizontalAlignment(SwingConstants.CENTER);
        setText(imageLabelText);
        addMouseListener(new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                if (e.getButton() == MouseEvent.BUTTON1)  {
                    addImage();
                }
            }
        });
        JPopupMenu menu = new JPopupMenu();
        JMenuItem copyAddress = new JMenuItem(Lang.getInstance().translate("Reset"));
        copyAddress.addActionListener(e -> reset());
        menu.add(copyAddress);
        setComponentPopupMenu(menu);
    }


    private void addImage() {
        // открыть диалог для файла
        fileChooser chooser = new fileChooser();
        chooser.setFileSelectionMode(JFileChooser.FILES_ONLY);
        chooser.setMultiSelectionEnabled(false);
        FileNameExtensionFilter filter = new FileNameExtensionFilter("Image", "png", "jpg", "gif");
        chooser.setFileFilter(filter);
        chooser.setDialogTitle(Lang.getInstance().translate("Open Image") + "...");
        int returnVal = chooser.showOpenDialog(getParent());
        if (returnVal == JFileChooser.APPROVE_OPTION) {
            File file = new File(chooser.getSelectedFile().getPath());
            new ImageCropDialog(file, bezelWidth, bezelHeight) {
                @Override
                public void onFinish(BufferedImage image) {
                    setIcon(new ImageIcon(image));
                    setPreferredSize(new Dimension(image.getWidth(), image.getHeight()));
                    setText(imageLabelText);
                    ByteArrayOutputStream imageStream = new ByteArrayOutputStream();
                    try {
                        ImageIO.write(image, "jpeg", imageStream);
                        imgBytes = imageStream.toByteArray();
                    } catch (Exception e) {
                        logger.error("Can not write image in ImageCropDialog dialog onFinish method",e);
                    }
                }
            };
        }
    }

    public void reset() {
        imgBytes = null;
        setIcon(null);
        setText(imageLabelText);
    }

    public byte[] getImgBytes() {
        return imgBytes;
    }
}
