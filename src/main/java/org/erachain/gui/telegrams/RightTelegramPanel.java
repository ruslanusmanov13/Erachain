package org.erachain.gui.telegrams;

import org.erachain.controller.Controller;
import org.erachain.core.transaction.Transaction;
import org.erachain.gui.library.MTable;
import org.erachain.lang.Lang;
import org.erachain.utils.TableMenuPopupUtil;
import org.mapdb.Fun.Tuple3;

import javax.swing.*;
import javax.swing.event.PopupMenuEvent;
import javax.swing.event.PopupMenuListener;
import javax.swing.table.TableRowSorter;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * @author Саша
 */
public class RightTelegramPanel extends javax.swing.JPanel {

    /**
     * Creates new form rightTelegramPanel
     */
    JPopupMenu menu;

    public WalletTelegramsFilterTableModel walletTelegramsFilterTableModel;
    protected int row;


    public RightTelegramPanel() {

        walletTelegramsFilterTableModel = new WalletTelegramsFilterTableModel();
        jTableMessages = new MTable(walletTelegramsFilterTableModel);


        jTableMessages.setAutoCreateRowSorter(false);

        // jTableMessages.setRowHeight(50);
        jTableMessages.setDefaultRenderer(Long.class, new RendererMessage());
        jTableMessages.setDefaultRenderer(Tuple3.class, new RendererMessage());

// sorter
        TableRowSorter<WalletTelegramsFilterTableModel> t = new TableRowSorter<WalletTelegramsFilterTableModel>(walletTelegramsFilterTableModel);
        t.setSortable(0, false); //Указываем, что сортировать будем в первой колонке
        //   t.setSortable(1, false); // а в других нет

        if (false) {
            // comparator
            t.setComparator(0, new Comparator<Tuple3<String, String, Transaction>>() {
                @Override
                public int compare(Tuple3<String, String, Transaction> o1, Tuple3<String, String, Transaction> o2) {
                    // TODO Auto-generated method stub
                    return o2.c.getTimestamp().compareTo(o1.c.getTimestamp());
                }
            });
        }

        // sort list  - AUTO sort
        List<RowSorter.SortKey> sortKeys = new ArrayList<RowSorter.SortKey>();
        sortKeys.add(new RowSorter.SortKey(0, SortOrder.ASCENDING));
        t.setSortKeys(sortKeys);
        // sort table
        jTableMessages.setRowSorter(t);
        // end sortet

        initComponents();

        initMenu();

        TableMenuPopupUtil.installContextMenu(jTableMessages, menu);

    }

    /**
     * This method is called from within the constructor to initialize the form.
     * WARNING: Do NOT modify this code. The content of this method is always
     * regenerated by the Form Editor.
     */

    // <editor-fold defaultstate="collapsed" desc="Generated Code">
    private void initComponents() {
        java.awt.GridBagConstraints gridBagConstraints;

        jPanelTop = new javax.swing.JPanel();
        jLabelLeft = new javax.swing.JLabel();
        jLabelCenter = new javax.swing.JLabel();
        jLabelRaght = new javax.swing.JLabel();
        jScrollPaneCenter = new javax.swing.JScrollPane();
        jcheckIsEnscript = new JCheckBox();
        jPanelBottom = new javax.swing.JPanel();
        jScrollPaneText = new javax.swing.JScrollPane();
        jTextPaneText = new javax.swing.JTextPane();
        jButtonSendTelegram = new javax.swing.JButton();

        java.awt.GridBagLayout layout = new java.awt.GridBagLayout();
        layout.columnWidths = new int[]{0};
        layout.rowHeights = new int[]{0, 8, 0, 8, 0};
        setLayout(layout);

        java.awt.GridBagLayout jPanelTopLayout = new java.awt.GridBagLayout();
        jPanelTopLayout.columnWidths = new int[]{0, 6, 0, 6, 0};
        jPanelTopLayout.rowHeights = new int[]{0};
        jPanelTop.setLayout(jPanelTopLayout);

        jLabelLeft.setHorizontalAlignment(javax.swing.SwingConstants.RIGHT);
        jLabelLeft.setText("jLabel1");
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 0;
        gridBagConstraints.fill = java.awt.GridBagConstraints.HORIZONTAL;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_END;
        gridBagConstraints.weightx = 0.3;
        jPanelTop.add(jLabelLeft, gridBagConstraints);

        jLabelCenter.setText("jLabel2");
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 2;
        gridBagConstraints.gridy = 0;
        jPanelTop.add(jLabelCenter, gridBagConstraints);

        jLabelRaght.setText("jLabel3");
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 4;
        gridBagConstraints.gridy = 0;
        gridBagConstraints.fill = java.awt.GridBagConstraints.HORIZONTAL;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 0.3;
        jPanelTop.add(jLabelRaght, gridBagConstraints);

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 0;
        gridBagConstraints.fill = java.awt.GridBagConstraints.HORIZONTAL;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.insets = new java.awt.Insets(9, 10, 0, 11);
        add(jPanelTop, gridBagConstraints);

        jScrollPaneCenter.setViewportView(jTableMessages);

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 2;
        gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.weighty = 0.6;
        gridBagConstraints.insets = new java.awt.Insets(0, 10, 0, 11);
        add(jScrollPaneCenter, gridBagConstraints);

        java.awt.GridBagLayout jPanelBottomLayout = new java.awt.GridBagLayout();
        jPanelBottomLayout.columnWidths = new int[]{0, 6, 0};
        jPanelBottomLayout.rowHeights = new int[]{0};
        jPanelBottom.setLayout(jPanelBottomLayout);

        jScrollPaneText.setViewportView(jTextPaneText);

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 0;
        gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 1.0;
        gridBagConstraints.weighty = 0.2;
        jPanelBottom.add(jScrollPaneText, gridBagConstraints);

        jButtonSendTelegram.setText("jButton1");
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 2;
        gridBagConstraints.gridy = 0;
        gridBagConstraints.fill = java.awt.GridBagConstraints.VERTICAL;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.weighty = 0.2;
        jPanelBottom.add(jButtonSendTelegram, gridBagConstraints);


        jcheckIsEnscript.setSelected(true);
        jcheckIsEnscript.setText(Lang.getInstance().translate("Encrypt message"));
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 1;
        gridBagConstraints.fill = java.awt.GridBagConstraints.HORIZONTAL;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 1.0;
        gridBagConstraints.gridwidth = 2;

        jPanelBottom.add(jcheckIsEnscript, gridBagConstraints);

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 4;
        gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.weighty = 0.1;
        gridBagConstraints.insets = new java.awt.Insets(0, 10, 10, 11);
        add(jPanelBottom, gridBagConstraints);
    }// </editor-fold>


    private void initMenu() {
        // menu

        menu = new JPopupMenu();

        menu.addPopupMenuListener(new PopupMenuListener() {

            @Override
            public void popupMenuCanceled(PopupMenuEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void popupMenuWillBecomeInvisible(PopupMenuEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void popupMenuWillBecomeVisible(PopupMenuEvent arg0) {
                // TODO Auto-generated method stub
                int row1 = jTableMessages.getSelectedRow();
                if (row1 < 0) {
                    return;
                }
                row = jTableMessages.convertRowIndexToModel(row1);
            }
        });

        JMenuItem deleteTelegram = new JMenuItem(Lang.getInstance().translate("Delete Telegram"));
        deleteTelegram.addActionListener(new ActionListener() {
            public void actionPerformed(ActionEvent e) {


                Tuple3<Long, Long, Transaction> tt = (Tuple3<Long, Long, Transaction>) walletTelegramsFilterTableModel.getValueAt(row, 0);
                Controller.getInstance().getWallet().database.getTelegramsMap().delete(tt.c.viewSignature());
                //     System.out.println(row);
            }
        });
        menu.add(deleteTelegram);


    }

    // Variables declaration - do not modify
    public javax.swing.JButton jButtonSendTelegram;
    public javax.swing.JLabel jLabelCenter;
    public javax.swing.JLabel jLabelLeft;
    public javax.swing.JLabel jLabelRaght;
    public javax.swing.JPanel jPanelBottom;
    private javax.swing.JPanel jPanelTop;
    private javax.swing.JScrollPane jScrollPaneCenter;
    private javax.swing.JScrollPane jScrollPaneText;
    public MTable jTableMessages;
    public javax.swing.JTextPane jTextPaneText;
    public JCheckBox jcheckIsEnscript;
    // End of variables declaration
}
